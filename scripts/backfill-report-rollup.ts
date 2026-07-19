import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import { sql, type SQL } from "drizzle-orm";
import postgres from "postgres";

import {
  stageHourAggregate,
  groupHourAggregate,
  refreshReportRollup,
  UNSETTLED_WINDOW_DAYS,
} from "@/lib/reporting/rollup";

// Backfill the reports rollup (migration 0112).
//
// DEFAULT: PREFLIGHT ONLY — prints the estimated rollup output-row counts and
// base rows scanned at 30 / 90 / all-time depth, WITHOUT writing anything. The
// estimate runs the exact aggregate SELECTs read-only, so it's an accurate count
// of what a real run would produce. Safe to run anytime (read-only).
//
// TO ACTUALLY WRITE: pass --apply together with a depth (--days=N or --all).
// This requires migration 0112 to be applied first and, since local == the
// shared prod DB, is gated on explicit sign-off. Idempotent (UPSERT), so a
// re-run is safe.
//
//   npx tsx scripts/backfill-report-rollup.ts                 # preflight only
//   npx tsx scripts/backfill-report-rollup.ts --apply --all   # full backfill
//   npx tsx scripts/backfill-report-rollup.ts --apply --days=90

function sinceForDays(days: number | null): SQL {
  return days === null
    ? sql`'-infinity'::timestamptz`
    : sql`now() - (${days}::int * interval '1 day')`;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const all = args.includes("--all");
  const daysArg = args.find((a) => a.startsWith("--days="));
  const depthDays: number | null = all
    ? null
    : daysArg
      ? Number(daysArg.split("=")[1])
      : null;

  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);

  try {
    console.log("=== Reports rollup backfill — PREFLIGHT (read-only) ===");
    const depths: Array<{ label: string; days: number | null }> = [
      { label: "30d", days: 30 },
      { label: "90d", days: 90 },
      { label: "all-time", days: null },
    ];
    for (const d of depths) {
      const since = sinceForDays(d.days);
      // preSnapshot=true so the estimate runs before migration 0112 is applied;
      // the snapshot columns never change row counts, so it stays accurate after.
      const stage = (await db.execute(
        sql`SELECT count(*)::int n FROM (${stageHourAggregate(since, true)}) t`,
      )) as unknown as { n: number }[];
      const group = (await db.execute(
        sql`SELECT count(*)::int n FROM (${groupHourAggregate(since, true)}) t`,
      )) as unknown as { n: number }[];
      const scanned = (await db.execute(
        sql`SELECT count(*)::int n FROM stage_sends WHERE status='sent' AND sent_at IS NOT NULL AND sent_at >= ${since}`,
      )) as unknown as { n: number }[];
      console.log(
        `  ${d.label.padEnd(9)} Fact A rows=${stage[0].n}  Fact B rows=${group[0].n}  (scans ${scanned[0].n} sent rows)`,
      );
    }
    console.log(
      `  Settle horizon: buckets older than ${UNSETTLED_WINDOW_DAYS}d are frozen after write.`,
    );

    if (!apply) {
      console.log(
        "\nPreflight only — no rows written. Re-run with --apply --all (or --days=N) to backfill.",
      );
      return;
    }

    console.log(
      `\n=== APPLYING backfill (depth: ${depthDays === null ? "all-time" : depthDays + "d"}) ===`,
    );
    const result = await refreshReportRollup(db as never, {
      recomputeSinceDays: depthDays,
    });
    console.log("  done:", JSON.stringify(result));
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
