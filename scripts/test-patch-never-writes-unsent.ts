import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// A PATCH MUST NEVER WRITE A FIELD THE CLIENT DID NOT SEND.
//
// ⭐ WHY THIS FILE EXISTS. `v === undefined` is not that test. A Zod schema can
// produce a value for an ABSENT key — through `.default()`, or a `.transform()`
// sitting outside `.optional()` that receives undefined and returns something.
// Those values are not undefined, so a loop that only skips undefined writes
// them over whatever was stored.
//
// Found on production 2026-09-30. Three update schemas inject:
//
//   campaignUpdateSchema      {name}         -> audience_filters: {}
//   offerUpdateSchema         {name}         -> sales_pages: []
//   providerPhoneUpdateSchema {dashboard_id} -> opt_out_footer: null
//
// The campaigns one emptied audience_filters on EVERY PATCH — a rename, a
// note, a date. 77 campaigns carry {} as a result, and the correlation on
// production is exact: 36 renamed campaigns, 36 with empty filters, 0 renamed
// campaigns with filters intact, against 614 never-renamed and all intact.
//
// ⚠️ THE BARS CALL THE REAL BUILDER. An earlier version of this test
// re-implemented the route's loop and asserted against its own copy, which
// proves nothing about the route (see feedback_derived_comparison_proves
// _nothing). buildUpdates() is imported from lib/api/build-updates.ts — the
// same function all three routes call.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-patch-never-writes-unsent.ts

import { readFileSync } from "node:fs";
import { sql, type SQL } from "drizzle-orm";

class Rollback extends Error {}

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const { buildUpdates } = await import("@/lib/api/build-updates");
  const { campaignUpdateSchema } = await import("@/lib/validators/campaigns");
  const offersV = (await import("@/lib/validators/offers")) as Record<string, unknown>;
  const phonesV = (await import("@/lib/validators/provider-phones")) as Record<string, unknown>;
  const { campaigns } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const all = async <T>(q: SQL): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  type Parsable = { parse: (x: unknown) => Record<string, unknown> };

  // ── PART A — the schemas really do inject, so the bars are not vacuous ────
  // ⭐ Without this the whole file could pass because nothing injects any more,
  // and a reader would take that as proof the guard works.
  console.log("PART A — the injection these bars defend against is REAL");
  const injected: [string, Parsable, Record<string, unknown>, string][] = [
    ["campaignUpdateSchema", campaignUpdateSchema as Parsable, { name: "x" }, "audience_filters"],
    ["offerUpdateSchema", offersV.offerUpdateSchema as Parsable, { name: "x" }, "sales_pages"],
    ["providerPhoneUpdateSchema", phonesV.providerPhoneUpdateSchema as Parsable, { dashboard_id: "d" }, "opt_out_footer"],
  ];
  for (const [label, schema, body, key] of injected) {
    const parsed = schema.parse(body);
    bar(
      `A ${label} still injects ${key} for an absent key`,
      key in parsed,
      `parsed = ${JSON.stringify(parsed)}`,
    );
  }

  // ── PART B — buildUpdates drops every unsent key ──────────────────────────
  console.log("\nPART B — the builder writes ONLY what the client sent");
  for (const [label, schema, body, key] of injected) {
    const raw = body;
    const updates = buildUpdates(schema.parse(raw), raw);
    bar(
      `B ${label}: ${key} is NOT in the update`,
      !(key in updates),
      `updates = ${JSON.stringify(updates)}`,
    );
    bar(
      `B ${label}: what WAS sent survives`,
      Object.keys(raw).every((k) => k in updates),
      `sent ${Object.keys(raw).join(",")} → wrote ${Object.keys(updates).join(",")}`,
    );
  }
  // An explicitly-sent empty value must still be written — the guard must not
  // suppress a deliberate clear.
  const explicit = { name: "x", sales_pages: [] };
  bar(
    "B ⭐ an EXPLICITLY sent empty value is still written",
    "sales_pages" in
      buildUpdates((offersV.offerUpdateSchema as Parsable).parse(explicit), explicit),
    "the guard keys off presence in the raw body, not on the value",
  );

  // ── PART C — end to end against the database ──────────────────────────────
  // ⭐ The bar that would have caught the original defect. PART B proves the
  // builder; this proves the row.
  console.log("\nPART C — a name-only PATCH leaves the stored filters alone");
  const [org] = await all<{ id: string }>(sql`select id from organizations limit 1`);
  try {
    await db.transaction(async (tx) => {
      const [c] = (await tx.execute(sql`
        insert into campaigns (org_id, slug, name, status, link_mode, audience_filters)
        values (${org.id}::uuid, ${"guard-" + Date.now()}, 'Before', 'active', 'manual',
                '{"include_no_status":true,"lifecycle_statuses":["cold"]}'::jsonb)
        returning id, audience_filters`)) as unknown as Record<string, unknown>[];
      const before = JSON.stringify(c.audience_filters);

      const raw = { name: "After" };
      const updates = buildUpdates(
        (campaignUpdateSchema as Parsable).parse(raw),
        raw,
        { nonUpdatable: new Set(["save_as_draft"]) },
      );
      const [after] = await tx
        .update(campaigns)
        .set(updates)
        .where(eq(campaigns.id, Number(c.id)))
        .returning();

      bar(
        "C ⭐ audience_filters survives a rename",
        JSON.stringify(after.audience_filters) === before,
        `${before} → ${JSON.stringify(after.audience_filters)}`,
      );
      bar("C …and the rename applied", after.name === "After", String(after.name));
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // ── PART D — no route may go back to the unguarded loop ───────────────────
  // ⚠️ A source scan, and therefore weak: it proves a file, not a request. It
  // exists only to stop a NEW update route copying the pattern that caused
  // this, which is how it spread to three routes in the first place.
  console.log("\nPART D — no update route reintroduces the unguarded loop");
  const routes = [
    "app/api/campaigns/[campaignId]/route.ts",
    "app/api/offers/[offerId]/route.ts",
    "app/api/providers/[providerId]/phones/[phoneId]/route.ts",
  ];
  for (const r of routes) {
    const src = readFileSync(r, "utf8");
    bar(
      `D ${r.split("/").slice(2).join("/")} uses buildUpdates`,
      src.includes("buildUpdates("),
      "and not a hand-rolled Object.entries loop",
    );
  }

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
