import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import {
  readProjectionCoverage,
  readStageDayResyncDiff,
  syncStageDayConversions,
  type StageDayResyncDiff,
} from "../lib/keitaro/stage-day-conversions";

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
//
// ⭐ THE DIFF IS THE PREDICATE --apply USES, AND THAT IS NOW STRUCTURAL RATHER
// THAN A PROMISE IN THIS COMMENT. This script no longer carries any SQL: the
// preview comes from readStageDayResyncDiff() and the write from
// syncStageDayConversions(), both in lib/keitaro/stage-day-conversions.ts, built
// from the same CTEs (stageDayLedgerCtes), the same change test
// (projectionChangedClause over PROJECTED_COLUMNS) and the same content test
// (projectionNonEmptyClause). The retyped copies that used to live here fell
// behind TWICE — Task 6 changed what a sale is and this file kept counting
// refunds; Phase 5 added `events` / `unmapped_conversions` to the write and to
// the zeroing test and this file listed neither — so for a while the run an
// operator approved was not the run that happened. Bars R1-R8 in
// scripts/test-stage-day-conversions.ts execute both against one world and
// require the row sets to be EQUAL.

const APPLY = process.argv.includes("--apply");

/**
 * User and host — the two parts that identify the Supabase project (the ref
 * lives in one or the other). NEVER the password, and never the whole string.
 */
function targetLabel(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    return `${decodeURIComponent(u.username)}@${u.hostname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main() {
  console.log(`Target DB: ${targetLabel()}${APPLY ? "  ⚠️  --apply (WRITES)" : "  (dry run)"}`);
  const scope = (await db.execute(sql`
    SELECT (SELECT count(*) FROM conversion_events)::int AS ledger_rows,
           (SELECT count(*) FROM conversion_events WHERE stage_id IS NOT NULL)::int AS stage_attributed,
           (SELECT count(*) FROM keitaro_stage_results)::int AS ksr_rows,
           -- Every column the projection writes, not just sales/revenue: a row
           -- whose only content is a breakdown or an unmapped count is one this
           -- run can change, so it belongs in the scope it reports.
           (SELECT count(*) FROM keitaro_stage_results
             WHERE checkouts <> 0 OR sales <> 0 OR revenue <> 0 OR pending_revenue <> 0
                OR events <> '{}'::jsonb OR unmapped_conversions <> 0)::int AS ksr_conversion_rows
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

  const diffs: StageDayResyncDiff[] = await readStageDayResyncDiff(db, {});

  const money = (s: string) => Number(s);
  const salesDelta = diffs.reduce((a, d) => a + (d.new_sales - d.old_sales), 0);
  const revenueDelta = diffs.reduce((a, d) => a + (money(d.new_revenue) - money(d.old_revenue)), 0);
  const pendingDelta = diffs.reduce(
    (a, d) => a + (money(d.new_pending_revenue) - money(d.old_pending_revenue)),
    0,
  );
  const unmappedDelta = diffs.reduce((a, d) => a + (d.new_unmapped - d.old_unmapped), 0);
  const eventsOnly = diffs.filter(
    (d) =>
      d.action === "rewrite" &&
      d.old_events !== d.new_events &&
      d.old_sales === d.new_sales &&
      money(d.old_revenue) === money(d.new_revenue),
  ).length;
  const byAction = (["insert", "rewrite", "zero"] as const)
    .map((a) => `${a} ${diffs.filter((d) => d.action === a).length}`)
    .join(" · ");
  const sign = (n: number) => (n >= 0 ? "+" : "");
  console.log(
    `\n${diffs.length} stage-day rows differ · sales ${sign(salesDelta)}${salesDelta} · revenue ${sign(revenueDelta)}$${revenueDelta.toFixed(2)} · pending ${sign(pendingDelta)}$${pendingDelta.toFixed(2)} · unmapped ${sign(unmappedDelta)}${unmappedDelta}`,
  );
  console.log(`by action: ${byAction}  (a 'zero' resets the breakdown and pending_revenue too)`);
  console.log(
    `${eventsOnly} rewrite(s) move the BREAKDOWN without moving sales/revenue — a per-event repair, or a row written before migration 0185`,
  );
  // `events` is a whole jsonb object per side; printed in full it makes the table
  // unreadable. The counts and the keys are what an operator approves on.
  const keysOf = (j: string) => {
    try {
      return Object.keys(JSON.parse(j) as Record<string, unknown>).join(",") || "-";
    } catch {
      return "?";
    }
  };
  console.table(
    diffs.slice(0, 50).map((d) => ({
      stage_id: d.stage_id,
      stat_date: d.stat_date,
      action: d.action,
      checkouts: `${d.old_checkouts}→${d.new_checkouts}`,
      sales: `${d.old_sales}→${d.new_sales}`,
      revenue: `${d.old_revenue}→${d.new_revenue}`,
      pending: `${d.old_pending_revenue}→${d.new_pending_revenue}`,
      payout: `${d.old_payout ?? "null"}→${d.new_payout ?? "null"}`,
      unmapped: `${d.old_unmapped}→${d.new_unmapped}`,
      events: `${keysOf(d.old_events)}→${keysOf(d.new_events)}`,
    })),
  );
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
