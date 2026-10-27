import "./_env-preload";

// THE FIRST FILL OF offer_group_exposure_mv (migration 0227) — one-off,
// attended (the owner typed "go now" in the session within 30 minutes —
// CLAUDE.md §14), quiet window only (before 08:00 ET / after 22:00 ET).
//
// 0227 creates the view WITH NO DATA (its build reads contact_offer_campaigns,
// ~1 GB, and does not fit prod's 120 s statement_timeout inside db:migrate).
// This runs fillOfferGroupExposure() from lib/reporting/offer-group-report.ts:
// a plain REFRESH on the report's own session-mode connection (180 s
// statement_timeout, raised work_mem), stamping its report_refresh_log row.
// Then run scripts/verify-offer-group-exposure.ts.
//
// ⭐ DRY RUN BY DEFAULT: prints the view's state and what it would do.
// `--apply` runs the fill.
//
// Run:
//   npx tsx --conditions=react-server scripts/fill-offer-group-exposure.ts
//   npx tsx --conditions=react-server scripts/fill-offer-group-exposure.ts --apply

const APPLY = process.argv.includes("--apply");

async function main() {
  const { withReadOnlyDb } = await import("./_readonly-db");
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").hostname;
  console.log(`${APPLY ? "⚠️  APPLY — THIS WRITES" : "DRY RUN — nothing will be written"} against ${host}`);
  console.log(`now ${new Date().toISOString()}`);

  const state = async () =>
    withReadOnlyDb(async (tx) => {
      const views = await tx<{ matviewname: string; ispopulated: boolean }[]>`
        SELECT matviewname, ispopulated FROM pg_matviews
        WHERE matviewname = 'offer_group_exposure_mv'`;
      const log = await tx<{ view_name: string; refreshed_at: string | null }[]>`
        SELECT view_name, refreshed_at::text FROM report_refresh_log
        WHERE view_name = 'offer_group_exposure_mv'`;
      return { views, log };
    });

  const before = await state();
  console.log("\nbefore:", JSON.stringify(before));
  if (before.views.length === 0) {
    throw new Error("offer_group_exposure_mv does not exist — apply migration 0227 first");
  }
  if (!APPLY) {
    console.log(
      "\nWould: REFRESH MATERIALIZED VIEW offer_group_exposure_mv (plain, first fill), stamping its log row.\n" +
        "DRY RUN — re-run with --apply.",
    );
    process.exit(0);
  }

  const { fillOfferGroupExposure } = await import("@/lib/reporting/offer-group-report");
  const r = await fillOfferGroupExposure();
  console.log(`\nfilled: ${(r.ms / 1000).toFixed(1)} s`);
  console.log("connection (settings read back on it):", JSON.stringify(r.connection));
  console.log("after:", JSON.stringify(await state()));
  console.log(`finished ${new Date().toISOString()} — now run scripts/verify-offer-group-exposure.ts`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
