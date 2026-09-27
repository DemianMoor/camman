import "./_env-preload";

// Fill lifecycle_day_rollup for a date range (migration 0192).
//
// The nightly job recomputes a 14-day trailing window, which is right for
// keeping late clicks and conversions landing but leaves everything older
// empty. This fills the rest, once, after the table is created.
//
// ⚠️ CHUNKED, NOT ONE STATEMENT. The underlying computation is the
// per-recipient query, which is linear with a large constant — a 92-day range
// in a single call is minutes and one lock. A few days at a time keeps each
// statement short and makes the run resumable: re-running only recomputes the
// chunks asked for, because the refresh deletes and reinserts per range.
//
// Run:
//   npx tsx --conditions=react-server scripts/backfill-lifecycle-rollup.ts --days 92
//   npx tsx --conditions=react-server scripts/backfill-lifecycle-rollup.ts --days 92 --chunk 3

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

async function main() {
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { refreshLifecycleDayRollup } = await import(
    "@/lib/reporting/lifecycle-rollup"
  );
  const { formatInCampaignTimezone } = await import("@/lib/campaign-timezone");

  const days = Number(arg("days") ?? "92");
  const chunk = Number(arg("chunk") ?? "3");
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x")
    .hostname;

  const orgs = (await db.execute(
    sql`SELECT id FROM organizations ORDER BY created_at`,
  )) as unknown as { id: string }[];
  if (orgs.length !== 1) throw new Error(`${orgs.length} orgs — assumes one`);
  const orgId = orgs[0].id;

  const day = (back: number) =>
    formatInCampaignTimezone(
      new Date(Date.now() - back * 86_400_000),
      "yyyy-MM-dd",
    );

  console.log(
    `filling lifecycle_day_rollup against ${host}\n` +
      `${days} day(s) back, ${chunk} day(s) per chunk\n`,
  );
  const started = Date.now();
  let rows = 0;
  for (let back = days - 1; back >= 0; back -= chunk) {
    const from = day(back);
    const to = day(Math.max(0, back - chunk + 1));
    const t0 = Date.now();
    const r = await refreshLifecycleDayRollup(db, { orgId, from, to });
    rows += r.rows;
    console.log(
      `  ${from}..${to}  ${String(Date.now() - t0).padStart(6)} ms  ` +
        `${r.rows} row(s)`,
    );
  }
  console.log(
    `\ndone: ${rows.toLocaleString()} row(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
