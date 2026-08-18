// W2 Task 1 — verification script for contact_org_stats rollup.
//
// Compares rollup values against live aggregates on production data and
// verifies the feature flag path. All DB writes are wrapped in a transaction
// that is rolled back in the finally block so no state persists.
//
// Run: npx tsx scripts/test-contact-stats-rollup.ts
// (after migration 0145 is applied AND the cron has run at least once)

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  bumpContactOrgStats,
  readContactOrgStats,
  refreshContactOrgStats,
} from "@/lib/contact-stats";

const client = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
const db = drizzle(client);

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

function assertClose(a: number, b: number, msg: string, tol = 0) {
  if (Math.abs(a - b) > tol) {
    throw new Error(`ASSERTION FAILED: ${msg} — expected ${b} got ${a}`);
  }
  console.log(`  ✓ ${msg} (${a})`);
}

async function main() {
  // Step 1: find an org that has data
  const orgRows = (await db.execute(
    sql`SELECT id FROM public.organizations LIMIT 1`,
  )) as unknown as { id: string }[];
  if (orgRows.length === 0) throw new Error("No organizations found");
  const orgId = orgRows[0]!.id;
  console.log(`\nTesting org: ${orgId}`);

  // Step 2: read live aggregates for comparison
  const [liveContacts] = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE NOT is_archived)::int AS total,
      count(*) FILTER (WHERE is_archived)::int AS archived
    FROM contacts WHERE org_id = ${orgId}::uuid
  `)) as unknown as { total: number; archived: number }[];
  const [liveOptOuts] = (await db.execute(sql`
    SELECT count(DISTINCT contact_id)::int AS opt_out_count
    FROM opt_outs WHERE org_id = ${orgId}::uuid
  `)) as unknown as { opt_out_count: number }[];
  const [liveOptIns] = (await db.execute(sql`
    SELECT count(DISTINCT contact_id)::int AS opt_in_count
    FROM opt_ins WHERE org_id = ${orgId}::uuid
  `)) as unknown as { opt_in_count: number }[];
  const [liveClickers] = (await db.execute(sql`
    SELECT count(DISTINCT contact_id)::int AS clicker_count
    FROM clickers WHERE org_id = ${orgId}::uuid
  `)) as unknown as { clicker_count: number }[];

  console.log("\nLive aggregates:");
  console.log("  total:", liveContacts?.total);
  console.log("  archived:", liveContacts?.archived);
  console.log("  opt_out_count:", liveOptOuts?.opt_out_count);
  console.log("  opt_in_count:", liveOptIns?.opt_in_count);
  console.log("  clicker_count:", liveClickers?.clicker_count);

  // Step 3: run refreshContactOrgStats in a rolled-back transaction
  await (db as ReturnType<typeof drizzle>).transaction(async (tx) => {
    try {
      // Run a full refresh in the transaction context
      await refreshContactOrgStats(tx as never, orgId);

      // Read back from rollup
      const { base, carrier, updatedAt } = await readContactOrgStats(tx as never, orgId);

      console.log("\nRollup values:");
      console.log("  total:", base.total);
      console.log("  archived:", base.archived);
      console.log("  opt_out_count:", base.opt_out_count);
      console.log("  opt_in_count:", base.opt_in_count);
      console.log("  clicker_count:", base.clicker_count);
      console.log("  carrier_breakdown present:", carrier !== null);
      console.log("  updated_at:", updatedAt);

      // Assert rollup matches live aggregates (exact match since we just refreshed)
      assertClose(base.total, Number(liveContacts?.total ?? 0), "total_count matches live");
      assertClose(base.archived, Number(liveContacts?.archived ?? 0), "archived_count matches live");
      assertClose(base.opt_out_count, Number(liveOptOuts?.opt_out_count ?? 0), "opt_out_count matches live");
      assertClose(base.opt_in_count, Number(liveOptIns?.opt_in_count ?? 0), "opt_in_count matches live");
      assertClose(base.clicker_count, Number(liveClickers?.clicker_count ?? 0), "clicker_count matches live");

      assert(carrier !== null, "carrier_breakdown populated after refresh");
      assert(updatedAt !== null, "updated_at set after refresh");

      if (carrier) {
        assert(typeof carrier.total === "number", "carrier.total is a number");
        assert(typeof carrier.by_line_type === "object", "carrier.by_line_type is present");
        assert(typeof carrier.by_carrier_norm === "object", "carrier.by_carrier_norm is present");
        assert(typeof carrier.by_messaging_status === "object", "carrier.by_messaging_status is present");

        // Verify carrier total matches contact total
        const carrierSum = Object.values(carrier.by_line_type).reduce(
          (s, n) => s + Number(n),
          0,
        );
        assertClose(
          carrierSum,
          base.total + base.archived,
          "by_line_type sums to total+archived",
        );
      }

      // Test bumpContactOrgStats delta increment
      await bumpContactOrgStats(tx as never, orgId, { total: 5, opt_out: 2 });
      const { base: bumped } = await readContactOrgStats(tx as never, orgId);
      assertClose(bumped.total, base.total + 5, "bump total += 5");
      assertClose(bumped.opt_out_count, base.opt_out_count + 2, "bump opt_out += 2");

      // Negative delta (simulate archive)
      await bumpContactOrgStats(tx as never, orgId, { archived: 3 });
      const { base: bumped2 } = await readContactOrgStats(tx as never, orgId);
      assertClose(bumped2.archived, base.archived + 3, "bump archived += 3");

      console.log("\n✅ All assertions passed");
    } finally {
      // Always roll back so prod data is unchanged
      throw new Error("INTENTIONAL_ROLLBACK");
    }
  }).catch((e: Error) => {
    if (e.message === "INTENTIONAL_ROLLBACK") {
      console.log("  (transaction rolled back — no prod changes)");
    } else {
      throw e;
    }
  });
}

main()
  .then(() => {
    console.log("\nDone.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("\n❌", e.message);
    process.exit(1);
  });
