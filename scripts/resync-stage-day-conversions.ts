import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import { CAMPAIGN_TIMEZONE } from "../lib/campaign-timezone";
import { readProjectionCoverage, syncStageDayConversions } from "../lib/keitaro/stage-day-conversions";

// ONE-SHOT full reprojection of keitaro_stage_results' conversion columns from
// the conversion_events ledger. The */5 poll only re-derives the stages it
// touched, so a stage-day frozen by a re-post BEFORE Phase 3 shipped (recon bug
// 2: one conversion counted on two days, +$100) is only repaired here.
//
//   npx tsx scripts/resync-stage-day-conversions.ts            # dry run, prints every diff
//   npx tsx scripts/resync-stage-day-conversions.ts --apply    # writes (prod needs approval)
//
// Dry run is read-only and lists exactly the rows --apply would change (insert /
// rewrite / zero). --apply writes inside one transaction.
//
// Both paths pre-flight readProjectionCoverage() — the projection's own guard —
// and refuse on `empty_ledger` or `ledger_behind_history` before printing a diff
// that would read as "every row must be zeroed".

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
  old_payout: string | null;
  new_payout: string | null;
  old_pending: string;
  action: string;
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
  // PRE-FLIGHT = the projection's OWN guard, read through the same exported
  // function (review fix A2) so the script and the */5 tick can never disagree
  // about what is safe. It runs here, before any diff is printed, because a diff
  // computed under a refusal reads as "every row must be zeroed".
  const coverage = await readProjectionCoverage(db, {});
  if (coverage.refused === "empty_ledger") {
    console.log(
      "REFUSING (empty_ledger): conversion_events holds no stage-attributed rows, so every stage-day would be zeroed. Run the Phase 1 backfill first: npx tsx scripts/backfill-conversion-events.ts --apply",
    );
    process.exit(1);
  }
  if (coverage.refused === "ledger_behind_history") {
    console.log(
      `REFUSING (ledger_behind_history): keitaro_stage_results reports conversions from ${coverage.reportedHistoryFloor} (ET) but the ledger only covers from ${coverage.ledgerFloor} (ET).`,
    );
    console.log(
      "Re-deriving now would REDUCE every reported day the ledger cannot fully explain to its partial sum. Run the Phase 1 backfill (scripts/backfill-conversion-events.ts --apply) until the ledger covers the reported history, then re-run this script.",
    );
    process.exit(1);
  }
  console.log(
    `Ledger coverage starts ${coverage.ledgerFloor} (ET), at or before the earliest reported conversion day. The diff below applies the same per-stage coverage floor --apply does: a stage-day the ledger does not explain is listed only when it sits on or after that stage's OWN earliest ledger conversion.`,
  );

  // THE DIFF IS THE PREDICATE --apply USES, not an approximation of it (review
  // fix A4). Three ways --apply changes a row, all listed:
  //   insert  — the ledger explains a (stage, day) with no stored row
  //   rewrite — a stored row whose checkouts / sales / revenue / PAYOUT differs
  //             (payout alone differs on rows written before the column existed,
  //             and repairing those is the whole reason the upsert tests it)
  //   zero    — a covered day the ledger no longer explains, which also resets
  //             PENDING_REVENUE, so a row whose only non-zero column is pending
  //             is a real change and has to be printed
  // `l` is joined on org as well, exactly like the upsert's JOIN to
  // campaign_stages: a ledger row whose org doesn't match its stage writes
  // nothing, so it must not show up here as a pending change either.
  const diffs = (await db.execute(sql`
    WITH ledger_raw AS (
      SELECT ce.org_id,
             ce.stage_id,
             (ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date AS stat_date,
             count(*) FILTER (WHERE ce.keitaro_type IN ('lead', 'sale', 'rejected'))::int AS sales,
             count(*) FILTER (WHERE ce.keitaro_type = 'lead')::int AS checkouts,
             coalesce(sum(ce.revenue) FILTER (WHERE ce.keitaro_type IN ('lead', 'sale', 'rejected')), 0)::numeric(12,4) AS revenue
      FROM conversion_events ce
      JOIN campaign_stages cs ON cs.id = ce.stage_id AND cs.org_id = ce.org_id
      WHERE ce.stage_id IS NOT NULL
      GROUP BY 1, 2, 3
    ), ledger AS (
      SELECT r.*,
             CASE WHEN r.sales > 0 THEN (r.revenue / r.sales)::numeric(12,4) ELSE NULL END AS payout
      FROM ledger_raw r
    ), stage_floor AS (
      -- Byte-for-byte the zeroing UPDATE's cov subquery: EVERY stage-attributed ledger
      -- row, org-grouped, with NO join to campaign_stages. (The write side above
      -- does join it — the two bounds differ there, and this diff must reproduce
      -- each one where it applies, not the nicer of the two.)
      SELECT ce.org_id, ce.stage_id,
             min((ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date) AS floor_date
      FROM conversion_events ce
      WHERE ce.stage_id IS NOT NULL
      GROUP BY 1, 2
    )
    SELECT coalesce(k.stage_id, l.stage_id) AS stage_id,
           coalesce(k.stat_date, l.stat_date)::text AS stat_date,
           coalesce(k.sales, 0) AS old_sales, coalesce(l.sales, 0) AS new_sales,
           coalesce(k.revenue, 0)::text AS old_revenue, coalesce(l.revenue, 0)::text AS new_revenue,
           coalesce(k.checkouts, 0) AS old_checkouts, coalesce(l.checkouts, 0) AS new_checkouts,
           k.payout_at_conversion::text AS old_payout, l.payout::text AS new_payout,
           coalesce(k.pending_revenue, 0)::text AS old_pending,
           CASE WHEN k.id IS NULL THEN 'insert'
                WHEN l.stage_id IS NOT NULL THEN 'rewrite'
                ELSE 'zero' END AS action
    FROM keitaro_stage_results k
    FULL OUTER JOIN ledger l
      ON l.stage_id = k.stage_id AND l.org_id = k.org_id AND l.stat_date = k.stat_date
    LEFT JOIN stage_floor f ON f.stage_id = k.stage_id AND f.org_id = k.org_id
    WHERE (
        l.stage_id IS NOT NULL AND (
             k.id IS NULL
          OR k.checkouts            IS DISTINCT FROM l.checkouts
          OR k.sales                IS DISTINCT FROM l.sales
          OR k.revenue              IS DISTINCT FROM l.revenue
          OR k.payout_at_conversion IS DISTINCT FROM l.payout)
      )
      OR (
        l.stage_id IS NULL
        -- Outside that stage's coverage nothing happens, so it is not a diff —
        -- same per-stage bound as syncStageDayConversions.
        AND f.floor_date IS NOT NULL AND k.stat_date >= f.floor_date
        AND (k.checkouts <> 0 OR k.sales <> 0 OR k.revenue <> 0 OR k.pending_revenue <> 0)
      )
    ORDER BY 1, 2
  `)) as unknown as Diff[];

  const money = (s: string) => Number(s);
  const salesDelta = diffs.reduce((a, d) => a + (d.new_sales - d.old_sales), 0);
  const revenueDelta = diffs.reduce((a, d) => a + (money(d.new_revenue) - money(d.old_revenue)), 0);
  const byAction = ["insert", "rewrite", "zero"]
    .map((a) => `${a} ${diffs.filter((d) => d.action === a).length}`)
    .join(" · ");
  console.log(`\n${diffs.length} stage-day rows differ · sales ${salesDelta >= 0 ? "+" : ""}${salesDelta} · revenue ${revenueDelta >= 0 ? "+" : ""}$${revenueDelta.toFixed(2)}`);
  console.log(`by action: ${byAction}  (a 'rewrite' with equal sales/revenue/checkouts is a payout repair; a 'zero' also resets pending_revenue)`);
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
