import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { loadEventTypes, visibleEventTypes } from "@/lib/reporting/event-columns";

// PREVIEW DB ONLY, inside a transaction that ALWAYS rolls back:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-event-columns-db.ts
//
// The refusal is the `_require-preview-db` import above — an ALLOWLIST, and early
// enough that nothing can query ahead of it. Deliberately NOT a hand-copied
// `if (DATABASE_URL.includes(<prod ref>))` test: that is a denylist, it passes
// every target nobody thought of, and scripts/test-preview-db-guard.ts rejects a
// re-copied project-ref literal outside the helper for exactly that reason.
//
// ⭐ EVERY BAR THAT CAN FAIL IS ABOUT A TYPE PRODUCTION DOES NOT HAVE. The two
// seeded types are asserted only as a baseline; the discriminating bars are about
// `deposit` — a THIRD type with ZERO conversions — and about an ARCHIVED type. A
// test that only asserted the two seeded rows would pass against a loader that
// returned a hard-coded array.

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

class Rollback extends Error {}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  let rolledBack = false;
  try {
    await db.transaction(async (tx) => {
      const orgs = (await tx.execute(sql`
        SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 2
      `)) as unknown as { id: string }[];
      const orgId = orgs[0]?.id;
      if (!orgId) throw new Error("no organization on the preview DB");

      const base = await loadEventTypes(tx, orgId);
      check("L1 the seeded registry loads for one org", base.length >= 2, base.map((t) => t.key).join(","));
      check(
        "L2 ⭐ signals sort first, against the seeded display_order (10 vs 20)",
        base.map((t) => t.key).join(",").startsWith("registration,purchase"),
        base.map((t) => `${t.key}:${t.display_order}`).join(","),
      );
      check("L3 the purchase type carries is_purchase AND counts_revenue", !!base.find((t) => t.key === "purchase" && t.is_purchase && t.counts_revenue));
      check("L4 the registration type carries is_retarget_signal and NOT counts_revenue", !!base.find((t) => t.key === "registration" && t.is_retarget_signal && !t.counts_revenue));

      await tx.execute(sql`
        INSERT INTO event_types (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
        VALUES (${orgId}::uuid, 'deposit', 'Deposits', 30, true, true, false)
      `);
      const three = await loadEventTypes(tx, orgId);
      check("L5 ⭐ a THIRD event type with ZERO conversions appears in the spec", three.some((t) => t.key === "deposit"), three.map((t) => t.key).join(","));
      check(
        "L6 ⭐ and it is VISIBLE against an empty result set (the column exists and reads 0)",
        visibleEventTypes(three, [{}]).some((t) => t.key === "deposit"),
      );
      check(
        "L7 ordering with a second purchase type is signals, then purchases by display_order",
        three.map((t) => t.key).join(",") === "registration,purchase,deposit",
        three.map((t) => t.key).join(","),
      );

      await tx.execute(sql`
        UPDATE event_types SET status = 'archived', archived_at = now()
        WHERE org_id = ${orgId}::uuid AND key = 'deposit'
      `);
      const arch = await loadEventTypes(tx, orgId);
      check("L8 ⭐ an archived type is still LOADED (history must not vanish)", arch.some((t) => t.key === "deposit" && t.archived));
      check("L9 ⭐ but it is not VISIBLE with no data in scope", !visibleEventTypes(arch, [{}]).some((t) => t.key === "deposit"));
      check(
        "L10 ⭐ and it IS visible the moment a displayed row carries money for it",
        visibleEventTypes(arch, [{ deposit: { n: 0, pending_n: 0, revenue: 9.5, pending_revenue: 0 } }]).some((t) => t.key === "deposit"),
      );

      const otherOrg = orgs[1]?.id;
      if (otherOrg && otherOrg !== orgId) {
        const other = await loadEventTypes(tx, otherOrg);
        check("L11 ⭐ the per-org load does NOT see the other org's new type", !other.some((t) => t.key === "deposit"), other.map((t) => t.key).join(","));
      } else {
        check("L11 skipped — the preview DB has only one organization", true);
      }
      const cross = await loadEventTypes(tx, null);
      check("L12 ⭐ the cross-org load (Telegram) DOES see it, merged by key", cross.some((t) => t.key === "deposit"));
      check(
        "L13 ⭐ the cross-org load returns ONE row per key, not one per org",
        new Set(cross.map((t) => t.key)).size === cross.length,
        cross.map((t) => t.key).join(","),
      );

      throw new Rollback();
    });
  } catch (e) {
    if (e instanceof Rollback) rolledBack = true;
    else throw e;
  }
  check("L14 the probe transaction rolled back", rolledBack);
  // ⭐ L14 is bookkeeping — it only proves this process threw. L15 asks the
  // DATABASE, outside the transaction, whether the row it inserted survived.
  // Without it a committed probe would leave a fabricated event type on the
  // preview DB and every later run of this script would still print PASS.
  const leaked = (await db.execute(sql`
    SELECT count(*)::int AS n FROM event_types WHERE key = 'deposit'
  `)) as unknown as { n: number }[];
  check("L15 ⭐ and the DB agrees: the probe's event type is gone outside it", Number(leaked[0]?.n) === 0, `deposit rows remaining: ${leaked[0]?.n}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  await pgConn.end();
  process.exit(failed > 0 ? 1 : 0);
}

void main();
