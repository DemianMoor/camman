import "./_env-preload";

// BACKFILL stage_send_lifecycle.last_click_at FOR WARM STAMPS (migration 0220).
//
// A thin runner over lib/engagement/lifecycle-last-click.ts (the same function
// the one-shot quiet-window cron calls) — design notes live there. Only warm
// stamps with NULL last_click_at are touched; a re-run writes nothing.
//
// ⚠️ HEAVY: one transaction joining every warm stamp to its send and the
// contacts' human clicks. Run it in the 05:00 UTC quiet window.
//
// ⭐ DRY RUN BY DEFAULT: computes everything inside a transaction that rolls
// back and prints the split it WOULD produce. `--apply` commits.
//
// Run:
//   npx tsx --conditions=react-server scripts/backfill-lifecycle-last-click.ts --org <uuid>
//   npx tsx --conditions=react-server scripts/backfill-lifecycle-last-click.ts --org <uuid> --apply

const APPLY = process.argv.includes("--apply");
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

async function main() {
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { backfillWarmLastClick } = await import("@/lib/engagement/lifecycle-last-click");
  const { WARM_SPLIT_DAYS } = await import("@/lib/reporting/lifecycle-report");

  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").hostname;
  console.log(`${APPLY ? "⚠️  APPLY — THIS WRITES" : "DRY RUN — nothing will be written"} against ${host}`);

  let orgId = arg("org");
  if (!orgId) {
    const orgs = (await db.execute(sql`SELECT id FROM organizations`)) as unknown as { id: string }[];
    if (orgs.length !== 1) throw new Error(`${orgs.length} orgs — pass --org <uuid>`);
    orgId = orgs[0].id;
  }

  const t0 = Date.now();
  let result: Awaited<ReturnType<typeof backfillWarmLastClick>> | null = null;
  await db
    .transaction(async (tx) => {
      result = await backfillWarmLastClick(tx, { orgId: orgId!, apply: APPLY, splitDays: WARM_SPLIT_DAYS });
      if (!APPLY) throw new Error("__ROLLBACK__");
    })
    .catch((e) => {
      if (!(e instanceof Error) || e.message !== "__ROLLBACK__") throw e;
    });
  const r = result!;
  console.log("\nwarm stamps to fill:", { ...r, written: undefined });
  console.log(
    "  within_30d / beyond_120d: warm at evaluation but outside 31–120 measured at sent_at\n" +
      "  (the stamp's status is evaluated before the send). They are still Warm and land in\n" +
      "  31–60 / 61–120 respectively — the stamp, not this script, decides the cohort.",
  );
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!APPLY) {
    console.log("DRY RUN — re-run with --apply to write.");
  } else {
    console.log(`done: ${r.written.toLocaleString()} stamp(s) written`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
