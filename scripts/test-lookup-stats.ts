import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

import { createRequire } from "node:module";

import { sql } from "drizzle-orm";

import { fictionalPhones, refuseIfPhonesInUse } from "./_fictional-phones";

// THE LOOKUP STATS PANEL (lib/telnyx/lookup-stats.ts), run over a world this
// script builds, checks and tears down itself.
//
// ⚠️ PREVIEW-ONLY, AND IT WRITES. `.env.local` IS PRODUCTION. Run it as:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-lookup-stats.ts
// The `_require-preview-db` import above is the refusal; it runs before
// db/client is evaluated.
//
// ⭐ WHY IT BUILDS ITS OWN WORLD (2026-09-22). It used to load `.env.local` with
// dotenv, so a bare run read PRODUCTION and, through refreshLookupGroupStats,
// overwrote the first org's real lookup_group_stats_cache row. Its only bars were
// the reconciliation identities, and those hold vacuously over an empty org
// (0 = 0 + 0 + 0). It now seeds a throwaway org whose name carries MARKER and
// asserts the EXACT numbers that world must produce.
//
// ⭐ ITS WRITE IS INSIDE A LIBRARY. refreshLookupGroupStats upserts the cache
// row, and the check:guards source scan cannot see a library write, so this
// file is named in GUARDED_VIA_LIBRARY there: the guard is REQUIRED, not
// merely present.
//
// ⭐ phone_lookups IS GLOBAL (PK = phone, no org_id), and the stats join it by
// phone. The world's numbers come from _fictional-phones, the run refuses to
// start if any is already in use, and teardown deletes only the phone_lookups
// keys this run inserted. Everything else hangs off the marker org and cascades
// from it.
//
// The world (one-sided, so no bar can pass for the wrong reason):
//   c1 mobile,   looked up (telnyx)                     → A
//   c2 mobile,   looked up (csv_import), TWO opt-outs    → A and B  (a duplicate opt-out
//                                                         must not double-count; a
//                                                         multi-group contact counts
//                                                         once in the summary)
//   c3 landline, looked up (telnyx), opted out          → A        (a landline, not an opt-out)
//   c4 unknown,  never looked up                        → B
//   c5 mobile,   looked up (telnyx)                     → C only   (C is ARCHIVED: nowhere)
//   c6 mobile,   looked up (csv_import)                 → no group (nowhere)

const req = createRequire(import.meta.url);
try {
  const p = req.resolve("server-only");
  // @ts-expect-error minimal Module cache entry
  req.cache[p] = { id: p, filename: p, loaded: true, exports: {} };
} catch {
  /* noop */
}

const MARKER = "__LOOKUP_STATS_TEST__";

/** What the world seeds, per stat. `remaining` = total − looked_up. */
const EXPECT = {
  A: { total: 3, looked_up: 3, telnyx: 2, manual: 1, landlines: 1, opt_outs: 1, sendable: 1, remaining: 0, coverage_pct: 100 },
  B: { total: 2, looked_up: 1, telnyx: 0, manual: 1, landlines: 0, opt_outs: 1, sendable: 1, remaining: 1, coverage_pct: 50 },
  // Distinct contacts in ≥1 ACTIVE group: c1..c4 (c2 once, not twice).
  summary: { total: 4, looked_up: 3, telnyx: 2, manual: 1, landlines: 1, opt_outs: 1, sendable: 2, remaining: 1, coverage_pct: 75, groups: 2 },
};

let failures = 0;
function ok(cond: boolean, msg: string) {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
}
/** The fields EXPECT names, picked off `s` in EXPECT's order. */
function pick(s: object, keys: string[]): string {
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, (s as Record<string, unknown>)[k]])));
}

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const { pgArray } = await import("@/lib/telnyx/pg-array");
  const { computeLookupGroupStats, getLookupGroupStats, refreshLookupGroupStats } =
    await import("@/lib/telnyx/lookup-stats");
  console.log(`Target DB: ${requirePreviewDb().label}`);

  const one = async <T,>(q: ReturnType<typeof sql>): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];

  const tag = `ls-${Date.now()}`;
  const phones = fictionalPhones(6);
  await refuseIfPhonesInUse(db, phones); // before the first write
  const insertedLookups: string[] = []; // phone_lookups PKs THIS run inserted
  let orgId = "";

  try {
    // ── the world ───────────────────────────────────────────────────────────────
    orgId = (await one<{ id: string }>(sql`
      INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`)).id;
    const group = async (key: string, status: "active" | "archived") =>
      (await one<{ id: number }>(sql`
        INSERT INTO contact_groups (contact_group_id, org_id, name, status, archived_at)
        VALUES (${`${tag}-${key}`}, ${orgId}::uuid, ${`${MARKER} ${key}`}, ${status},
                ${status === "archived" ? sql`now()` : sql`NULL`})
        RETURNING id`)).id;
    const gA = await group("A", "active");
    const gB = await group("B", "active");
    const gC = await group("C", "archived");

    const contact = async (
      i: number,
      lineType: "mobile" | "landline" | "unknown",
      lookup: "telnyx" | "csv_import" | null,
      groups: number[],
      optOuts = 0,
    ) => {
      const phone = phones[i];
      const id = (await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number, line_type)
        VALUES (${orgId}::uuid, ${phone}, ${lineType}) RETURNING id`)).id;
      if (lookup) {
        const row = await one<{ phone: string }>(sql`
          INSERT INTO phone_lookups (phone, line_type, carrier_norm, source, lookup_status)
          VALUES (${phone}, ${lineType}, 'Unknown', ${lookup}, 'complete') RETURNING phone`);
        insertedLookups.push(row.phone);
      }
      for (const g of groups) {
        await db.execute(sql`
          INSERT INTO contact_contact_groups (contact_id, contact_group_id, org_id)
          VALUES (${id}::uuid, ${g}, ${orgId}::uuid)`);
      }
      for (let n = 0; n < optOuts; n++) {
        await db.execute(sql`
          INSERT INTO opt_outs (org_id, contact_id, phone_number) VALUES (${orgId}::uuid, ${id}::uuid, ${phone})`);
      }
    };
    await contact(0, "mobile", "telnyx", [gA]);
    await contact(1, "mobile", "csv_import", [gA, gB], 2);
    await contact(2, "landline", "telnyx", [gA], 1);
    await contact(3, "unknown", null, [gB]);
    await contact(4, "mobile", "telnyx", [gC]);
    await contact(5, "mobile", "csv_import", []);
    console.log(`   seeded org ${MARKER} ${tag}: 3 groups (1 archived), 6 contacts, ${insertedLookups.length} phone_lookups rows`);

    console.log("\n1) compute — exact over the seeded world, and the reconciliation identities:");
    const blob = await computeLookupGroupStats(orgId);
    const statKeys = Object.keys(EXPECT.A);
    const byId = new Map(blob.groups.map((g) => [g.group_id, g]));
    ok(blob.groups.length === 2, `exactly the 2 ACTIVE groups are reported (archived C is not): ${blob.groups.length}`);
    for (const [label, id, want] of [["A", gA, EXPECT.A], ["B", gB, EXPECT.B]] as const) {
      const g = byId.get(id);
      const got = g ? pick(g, statKeys) : "(missing)";
      ok(got === pick(want, statKeys), `group ${label}: ${got} == ${pick(want, statKeys)}`);
      if (g) {
        ok(g.sendable + g.landlines + g.opt_outs === g.total, `group ${label}: sendable + landlines + optOuts = total (${g.sendable}+${g.landlines}+${g.opt_outs}=${g.total})`);
        ok(g.telnyx + g.manual === g.looked_up, `group ${label}: telnyx + manual = looked_up (${g.telnyx}+${g.manual}=${g.looked_up})`);
      }
    }
    ok(!byId.has(gC), "the archived group is absent");
    const s = blob.summary;
    const sumKeys = Object.keys(EXPECT.summary);
    ok(pick(s, sumKeys) === pick(EXPECT.summary, sumKeys), `summary (distinct contacts across active groups): ${pick(s, sumKeys)} == ${pick(EXPECT.summary, sumKeys)}`);
    ok(s.sendable + s.landlines + s.opt_outs === s.total, "summary: sendable + landlines + optOuts = total");
    ok(s.telnyx + s.manual === s.looked_up, "summary: telnyx + manual = looked_up");

    console.log("\n2) refresh writes the blob; the cached read is fast:");
    const r0 = Date.now();
    const refreshed = await refreshLookupGroupStats(orgId);
    console.log(`   forced refresh (compute + atomic upsert): ${Date.now() - r0} ms`);
    ok(pick(refreshed.data.summary, sumKeys) === pick(EXPECT.summary, sumKeys), "the cache row holds this world's summary");
    ok(refreshed.stale === false, "freshly refreshed cache is not stale");
    const c0 = Date.now();
    await getLookupGroupStats(orgId);
    const cachedMs = Date.now() - c0;
    ok(cachedMs < 200, `cached read is fast (<200ms): ${cachedMs}ms`);

    console.log("\n3) failed refresh preserves prior cache:");
    const before = await getLookupGroupStats(orgId);
    console.log(`   cache computed_at before failed refresh: ${before.computed_at}`);
    let threw = false;
    try {
      await refreshLookupGroupStats(orgId, async () => {
        throw new Error("forced compute failure");
      });
    } catch (e) {
      threw = true;
      console.log(`   refresh threw as expected: ${(e as Error).message}`);
    }
    ok(threw, "a failing recompute throws (surfaced to the route as 500)");
    const after = await getLookupGroupStats(orgId);
    console.log(`   cache computed_at after  failed refresh: ${after.computed_at}`);
    ok(after.computed_at === before.computed_at, "prior cache computed_at UNCHANGED after failed refresh");
    ok(
      JSON.stringify(after.data.summary) === JSON.stringify(before.data.summary),
      "prior cache data UNCHANGED after failed refresh",
    );
  } finally {
    // ── teardown: only what this run created ──────────────────────────────────
    // phone_lookups by the exact PKs inserted above; everything else by org_id,
    // and only after re-reading the marker.
    if (insertedLookups.length) {
      await db.execute(sql`DELETE FROM phone_lookups WHERE phone = ANY(${pgArray(insertedLookups, "text")})`);
    }
    if (orgId) {
      const name = (await one<{ name: string } | undefined>(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} does not carry the test marker (name=${JSON.stringify(name)})`);
        failures++;
      } else {
        // contacts, contact_groups, contact_contact_groups, opt_outs and the
        // lookup_group_stats_cache row all cascade from organizations.id.
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
    }
    const org = sql`NULLIF(${orgId}, '')::uuid`;
    const left = await one<{ orgs: number; rows: number; lookups: number }>(sql`
      SELECT (SELECT count(*) FROM organizations WHERE name LIKE ${`%${MARKER} ${tag}%`})::int AS orgs,
             ((SELECT count(*) FROM contacts                 WHERE org_id = ${org})
            + (SELECT count(*) FROM contact_groups           WHERE org_id = ${org})
            + (SELECT count(*) FROM contact_contact_groups   WHERE org_id = ${org})
            + (SELECT count(*) FROM opt_outs                 WHERE org_id = ${org})
            + (SELECT count(*) FROM lookup_group_stats_cache WHERE org_id = ${org}))::int AS rows,
             (SELECT count(*) FROM phone_lookups WHERE phone = ANY(${pgArray(phones, "text")}))::int AS lookups`);
    console.log(`\nteardown: ${left.orgs} org(s), ${left.rows} org row(s), ${left.lookups} phone_lookups row(s) from this run (${tag}) left behind (expected 0, 0, 0)`);
    if (left.orgs !== 0 || left.rows !== 0 || left.lookups !== 0) failures++;
    const { sql: raw } = await import("@/db/client");
    await raw.end({ timeout: 5 });
  }

  console.log(
    failures === 0
      ? "\nAll lookup-stats checks passed ✅"
      : `\nFAILED: ${failures} check(s) ✗`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
