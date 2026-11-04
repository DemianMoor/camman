import "./_env-preload";

// THE FIRST FILL OF THE 0231 *_v2 REPORT VIEWS — one-off, attended (the owner
// typed "go now" in the session within 30 minutes — CLAUDE.md §14).
//
// 0231 creates offer_group_report_v2_mv, audience_report_group_totals_v2_mv and
// offer_report_offer_totals_v2_mv WITH NO DATA (the group view's ~165 s build
// does not fit db:migrate's 120 s statement_timeout). This runs
// fillOfferReportV2() from lib/reporting/offer-group-report.ts on the report's
// own session-mode connection (230 s per statement, 384 MB work_mem):
//   1. plain REFRESH of the three v2 views, in dependency order (group ->
//      audience -> totals), each stamping its report_refresh_log row;
//   2. CONCURRENTLY refresh of the three OLD views, so the verify compares two
//      snapshots minutes apart, not hours (an old-view failure is reported,
//      not thrown — the v2 fill already happened).
// Then run scripts/verify-offer-report-v2.ts. Expect ~7-8 minutes in total.
//
// ⛔ STOP BAR (Ruling R19), printed at the end: do not merge if the v2 group
// plain REFRESH took more than the old group CONCURRENTLY refresh of the same
// run + 5 s, or more than 200 s (the main cron run sits at ~280 of 300 s).
//
// ⛔ REFUSES TO RUN DURING THE REFRESH CRONS' HOURS: 04:00-05:59 and
// 19:00-20:59 UTC (the runs fire at 05:00 / 05:30 / 20:00 / 20:30 UTC and the
// group refresh alone takes ~3 minutes; a fill overlapping one would put two
// copies of the heaviest report query on prod at once). Coarse on purpose — a
// whole-hour rule cannot be mis-computed. Prefer the ET night (before 08:00 ET).
//
// ⭐ DRY RUN BY DEFAULT: prints the views' state and what it would do.
// `--apply` runs the fill.
//
// Run:
//   npx tsx --conditions=react-server scripts/fill-offer-report-v2.ts
//   npx tsx --conditions=react-server scripts/fill-offer-report-v2.ts --apply

const APPLY = process.argv.includes("--apply");
const V2 = ["offer_group_report_v2_mv", "audience_report_group_totals_v2_mv", "offer_report_offer_totals_v2_mv"];
const OLD = ["offer_group_report_mv", "audience_report_group_totals_mv", "offer_report_offer_totals_mv"];
const BLOCKED_UTC_HOURS = [4, 5, 19, 20];

async function main() {
  const { withReadOnlyDb } = await import("./_readonly-db");
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").hostname;
  const now = new Date();
  console.log(`${APPLY ? "⚠️  APPLY — THIS WRITES" : "DRY RUN — nothing will be written"} against ${host}`);
  console.log(`now ${now.toISOString()}`);

  if (BLOCKED_UTC_HOURS.includes(now.getUTCHours())) {
    console.error(
      `REFUSING: it is ${now.getUTCHours()}:xx UTC. The report refresh crons run at 05:00/05:30/20:00/20:30 UTC; ` +
        `this script will not start during UTC hours ${BLOCKED_UTC_HOURS.join(", ")}. Re-run at 06:00 UTC or later.`,
    );
    process.exit(1);
  }

  const state = async () =>
    withReadOnlyDb(async (tx) => {
      const views = await tx<{ matviewname: string; ispopulated: boolean }[]>`
        SELECT matviewname, ispopulated FROM pg_matviews
        WHERE matviewname = ANY(${[...V2, ...OLD]}) ORDER BY 1`;
      const log = await tx<{ view_name: string; refreshed_at: string | null }[]>`
        SELECT view_name, refreshed_at::text FROM report_refresh_log
        WHERE view_name = ANY(${[...V2, ...OLD]}) ORDER BY 1`;
      return { views: [...views], log: [...log] };
    });

  const before = await state();
  console.log("\nbefore:", JSON.stringify(before, null, 1));
  const missing = V2.filter((v) => !before.views.some((x) => x.matviewname === v));
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} missing — apply migration 0231 first`);
  }
  if (!APPLY) {
    console.log(
      "\nWould: REFRESH (plain, first fill) offer_group_report_v2_mv -> audience_report_group_totals_v2_mv -> " +
        "offer_report_offer_totals_v2_mv, stamping each log row; then REFRESH CONCURRENTLY the three old views.\n" +
        "DRY RUN — re-run with --apply.",
    );
    process.exit(0);
  }

  const { fillOfferReportV2 } = await import("@/lib/reporting/offer-group-report");
  const r = await fillOfferReportV2((view, ms) => console.log(`  ${view}: ${(ms / 1000).toFixed(1)} s`));
  console.log("\nper view (ms):", JSON.stringify(r.steps));
  console.log("connection (settings read back on it):", JSON.stringify(r.connection));
  // Stop bar (Ruling R19): the v2 group view must cost what the old one does.
  const v2g = r.steps.find((s) => s.view === "offer_group_report_v2_mv")?.ms ?? NaN;
  const oldg = r.steps.find((s) => s.view === "offer_group_report_mv" && s.ok)?.ms ?? NaN;
  const stop = !(v2g <= 200_000) || !(v2g <= oldg + 5_000);
  console.log(
    `${stop ? "⛔ STOP — do not merge" : "✓ stop bar clear"}: v2 group ${(v2g / 1000).toFixed(1)} s vs old group ` +
      `CONCURRENTLY ${(oldg / 1000).toFixed(1)} s (bar: v2 <= old + 5 s and v2 <= 200 s)`,
  );
  const oldFailed = r.steps.filter((s) => !s.ok);
  if (oldFailed.length > 0) {
    console.log(`⚠️  old-view refresh failed: ${oldFailed.map((s) => `${s.view} (${s.error})`).join("; ")} — ` +
      "the verify will report drift against an older snapshot of it.");
  }
  console.log("after:", JSON.stringify(await state(), null, 1));
  console.log(`finished ${new Date().toISOString()} — now run scripts/verify-offer-report-v2.ts`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
