import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import { CAMPAIGN_TIMEZONE } from "../lib/campaign-timezone";
import { syncStageDayConversions } from "../lib/keitaro/stage-day-conversions";

// ONE-SHOT full reprojection of keitaro_stage_results' conversion columns from
// the conversion_events ledger. The */5 poll only re-derives the stages it
// touched, so a stage-day frozen by a re-post BEFORE Phase 3 shipped (recon bug
// 2: one conversion counted on two days, +$100) is only repaired here.
//
//   npx tsx scripts/resync-stage-day-conversions.ts            # dry run, prints every diff
//   npx tsx scripts/resync-stage-day-conversions.ts --apply    # writes (prod needs approval)
//
// Dry run is read-only. --apply writes inside one transaction.

const APPLY = process.argv.includes("--apply");

interface Diff {
  stage_id: number;
  stat_date: string;
  old_sales: number;
  new_sales: number;
  old_revenue: string;
  new_revenue: string;
  old_checkouts: number;
  new_checkouts: number;
}

async function main() {
  const scope = (await db.execute(sql`
    SELECT (SELECT count(*) FROM conversion_events)::int AS ledger_rows,
           (SELECT count(*) FROM conversion_events WHERE stage_id IS NOT NULL)::int AS stage_attributed,
           (SELECT count(*) FROM keitaro_stage_results)::int AS ksr_rows,
           (SELECT count(*) FROM keitaro_stage_results WHERE sales <> 0 OR revenue <> 0)::int AS ksr_conversion_rows
  `)) as unknown as {
    ledger_rows: number;
    stage_attributed: number;
    ksr_rows: number;
    ksr_conversion_rows: number;
  }[];
  console.log("=== INPUT SCOPE ===");
  console.table(scope);
  // Kept here as well as inside syncStageDayConversions (which now refuses on the
  // same condition — review fix C1): this one refuses BEFORE printing a diff that
  // would read as "every row must be zeroed".
  if (scope[0].ledger_rows === 0 || scope[0].stage_attributed === 0) {
    console.log("REFUSING: the ledger is empty, so every stage-day would be zeroed. Run the Phase 1 backfill first.");
    process.exit(1);
  }
  const [floor] = (await db.execute(sql`
    SELECT min((ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date)::text AS coverage_floor
    FROM conversion_events ce WHERE ce.stage_id IS NOT NULL
  `)) as unknown as { coverage_floor: string | null }[];
  console.log(
    `Ledger coverage starts ${floor.coverage_floor} (ET). The diff below applies the same per-stage coverage floor --apply does: a stage-day the ledger does not explain is listed only when it sits on or after that stage's OWN earliest ledger conversion.`,
  );

  const diffs = (await db.execute(sql`
    WITH ledger AS (
      SELECT ce.stage_id,
             (ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date AS stat_date,
             count(*) FILTER (WHERE ce.keitaro_type IN ('lead', 'sale', 'rejected'))::int AS sales,
             count(*) FILTER (WHERE ce.keitaro_type = 'lead')::int AS checkouts,
             coalesce(sum(ce.revenue) FILTER (WHERE ce.keitaro_type IN ('lead', 'sale', 'rejected')), 0)::numeric(12,4) AS revenue
      FROM conversion_events ce
      WHERE ce.stage_id IS NOT NULL
      GROUP BY 1, 2
    ), stage_floor AS (
      SELECT ce.stage_id,
             min((ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date) AS floor_date
      FROM conversion_events ce
      WHERE ce.stage_id IS NOT NULL
      GROUP BY 1
    )
    SELECT coalesce(k.stage_id, l.stage_id) AS stage_id,
           coalesce(k.stat_date, l.stat_date)::text AS stat_date,
           coalesce(k.sales, 0) AS old_sales, coalesce(l.sales, 0) AS new_sales,
           coalesce(k.revenue, 0)::text AS old_revenue, coalesce(l.revenue, 0)::text AS new_revenue,
           coalesce(k.checkouts, 0) AS old_checkouts, coalesce(l.checkouts, 0) AS new_checkouts
    FROM keitaro_stage_results k
    FULL OUTER JOIN ledger l ON l.stage_id = k.stage_id AND l.stat_date = k.stat_date
    LEFT JOIN stage_floor f ON f.stage_id = k.stage_id
    WHERE (coalesce(k.sales, 0) <> coalesce(l.sales, 0)
        OR coalesce(k.revenue, 0) <> coalesce(l.revenue, 0)
        OR coalesce(k.checkouts, 0) <> coalesce(l.checkouts, 0))
      -- The ledger explains this day (it gets written), or the day is inside that
      -- stage's coverage (it gets zeroed). Outside coverage nothing happens, so
      -- the row is not a diff — same bound as syncStageDayConversions.
      AND (l.stage_id IS NOT NULL OR (f.floor_date IS NOT NULL AND k.stat_date >= f.floor_date))
    ORDER BY 1, 2
  `)) as unknown as Diff[];

  const money = (s: string) => Number(s);
  const salesDelta = diffs.reduce((a, d) => a + (d.new_sales - d.old_sales), 0);
  const revenueDelta = diffs.reduce((a, d) => a + (money(d.new_revenue) - money(d.old_revenue)), 0);
  console.log(`\n${diffs.length} stage-day rows differ · sales ${salesDelta >= 0 ? "+" : ""}${salesDelta} · revenue ${revenueDelta >= 0 ? "+" : ""}$${revenueDelta.toFixed(2)}`);
  console.table(diffs.slice(0, 50));
  if (diffs.length > 50) console.log(`… ${diffs.length - 50} more`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to write.");
    process.exit(0);
  }
  const result = await db.transaction(async (tx) => syncStageDayConversions(tx, {}));
  console.log(`\nAPPLIED: ${JSON.stringify(result)}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
