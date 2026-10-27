import "./_env-preload";

// THE FIRST FILL OF offer_group_lifecycle_v2_mv (migration 0226) — one-off,
// attended, quiet window only (before 08:00 ET / after 22:00 ET).
//
// 0226 creates the view WITH NO DATA (its build does not fit prod's 120 s
// statement_timeout inside db:migrate). This runs fillOfferGroupLifecycleV2()
// from lib/reporting/offer-group-report.ts: a plain REFRESH of v2 on the
// report's own session-mode connection (180 s statement_timeout, raised
// work_mem), then the OLD view's normal CONCURRENTLY refresh straight after, so
// scripts/verify-offer-group-lifecycle-v2.ts compares two snapshots minutes
// apart. Both report_refresh_log rows are stamped.
//
// ⭐ DRY RUN BY DEFAULT: prints the two views' state and what it would do.
// `--apply` runs the fill.
//
// Run:
//   npx tsx --conditions=react-server scripts/fill-offer-group-lifecycle-v2.ts
//   npx tsx --conditions=react-server scripts/fill-offer-group-lifecycle-v2.ts --apply

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
        WHERE matviewname IN ('offer_group_lifecycle_mv', 'offer_group_lifecycle_v2_mv')
        ORDER BY 1`;
      const log = await tx<{ view_name: string; refreshed_at: string | null }[]>`
        SELECT view_name, refreshed_at::text FROM report_refresh_log
        WHERE view_name IN ('offer_group_lifecycle_mv', 'offer_group_lifecycle_v2_mv')
        ORDER BY 1`;
      return { views, log };
    });

  const before = await state();
  console.log("\nbefore:", JSON.stringify(before));
  if (!before.views.some((v) => v.matviewname === "offer_group_lifecycle_v2_mv")) {
    throw new Error("offer_group_lifecycle_v2_mv does not exist — apply migration 0226 first");
  }
  if (!APPLY) {
    console.log(
      "\nWould: REFRESH MATERIALIZED VIEW offer_group_lifecycle_v2_mv (plain, first fill), " +
        "then REFRESH ... CONCURRENTLY offer_group_lifecycle_mv, stamping both log rows.\n" +
        "DRY RUN — re-run with --apply.",
    );
    process.exit(0);
  }

  const { fillOfferGroupLifecycleV2 } = await import("@/lib/reporting/offer-group-report");
  const t0 = Date.now();
  const r = await fillOfferGroupLifecycleV2();
  console.log(
    `\nfilled: v2 ${(r.v2Ms / 1000).toFixed(1)} s, old view ${(r.oldMs / 1000).toFixed(1)} s, ` +
      `total ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  console.log("connection (settings read back on it):", JSON.stringify(r.connection));
  console.log("after:", JSON.stringify(await state()));
  console.log(`finished ${new Date().toISOString()} — now run scripts/verify-offer-group-lifecycle-v2.ts`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
