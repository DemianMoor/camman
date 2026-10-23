import "./_env-preload";

// BACKFILL stage_send_lifecycle.last_click_at FOR WARM STAMPS (migration 0220).
//
// The Lifecycle report splits Warm into 31–60 and 61–120 days since the
// contact's last human click at send time. New stamps record last_click_at as
// they are written (lib/engagement/lifecycle-stamp.ts); every warm stamp
// written before that has NULL and shows as "Warm (no click time)" until this
// runs. Only WARM stamps are touched — no other row reads the column.
//
// THE VALUE is the contact's latest HUMAN click at or before the send's sent_at
// (HUMAN_CLICK imported, never retyped). A live stamp would have taken it from
// contact_engagement at prepare time instead, which can lag sent_at by the
// engagement job's cadence; for a backfill, the send instant is the definition
// the report states ("days since the last human click at send time").
//
// ⚠️ HEAVY: built for the 05:00 UTC quiet window. It reads stage_send_lifecycle
// once, joins the warm stamps to their sends, and builds the contacts' human
// clicks ONCE — so the I/O is a few large sequential reads, not a probe per row.
// The temp tables live on ONE dedicated session-mode connection (not the
// transaction pooler) and are dropped at the end. Only SET LOCAL is used.
//
// ⭐ DRY RUN BY DEFAULT: computes everything and prints the split it WOULD
// produce. `--apply` then writes in batches of --batch (default 50,000), each
// its own transaction, only where last_click_at IS NULL — so it is resumable
// and never overwrites a live stamp.
//
// Run:
//   npx tsx --conditions=react-server scripts/backfill-lifecycle-last-click.ts --org <uuid>
//   npx tsx --conditions=react-server scripts/backfill-lifecycle-last-click.ts --org <uuid> --apply

import postgres from "postgres";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSessionModeUrl } from "@/lib/db/session-url";

const APPLY = process.argv.includes("--apply");
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const BATCH = Number(arg("batch") ?? "50000");

async function main() {
  const { HUMAN_CLICK } = await import("@/lib/reporting/counted-clickers");
  const { WARM_SPLIT_DAYS } = await import("@/lib/reporting/lifecycle-report");
  const human = new PgDialect().sqlToQuery(HUMAN_CLICK).sql;

  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const db = postgres(toSessionModeUrl(raw), { prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} });
  const host = new URL(raw).hostname;
  console.log(`${APPLY ? "⚠️  APPLY — THIS WRITES" : "DRY RUN — nothing will be written"} against ${host}`);
  const t0 = Date.now();
  const lap = (what: string) => console.log(`  ${what}  (+${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  try {
    let orgId = arg("org");
    if (!orgId) {
      const orgs = await db<{ id: string }[]>`SELECT id FROM organizations`;
      if (orgs.length !== 1) throw new Error(`${orgs.length} orgs — pass --org <uuid>`);
      orgId = orgs[0].id;
    }

    // Build the working set. Plain (not ON COMMIT DROP) temp tables, so they
    // outlive each transaction on this one session; dropped in `finally`.
    await db.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '900s'`);
      await tx.unsafe(`SET LOCAL work_mem = '256MB'`);
      await tx.unsafe(`
        CREATE TEMP TABLE lb_target AS
        SELECT l.stage_send_id, ss.contact_id, ss.sent_at
        FROM stage_send_lifecycle l
        JOIN stage_sends ss ON ss.id = l.stage_send_id
        WHERE l.org_id = $1 AND l.status = 'warm' AND l.last_click_at IS NULL
          AND ss.status = 'sent' AND ss.sent_at IS NOT NULL`, [orgId]);
      await tx.unsafe(`ANALYZE lb_target`);
      lap("warm stamps without a click time collected");
      await tx.unsafe(`
        CREATE TEMP TABLE lb_clicks AS
        SELECT lk.contact_id, ck.clicked_at
        FROM clicks ck
        JOIN links lk ON lk.id = ck.link_id
        WHERE ck.org_id = $1 AND ${human}
          AND lk.contact_id IN (SELECT DISTINCT contact_id FROM lb_target)`, [orgId]);
      await tx.unsafe(`CREATE INDEX ON lb_clicks (contact_id, clicked_at)`);
      await tx.unsafe(`ANALYZE lb_clicks`);
      lap("their human clicks collected");
      await tx.unsafe(`
        CREATE TEMP TABLE lb_result AS
        SELECT t.stage_send_id, t.sent_at,
               (SELECT max(c.clicked_at) FROM lb_clicks c
                WHERE c.contact_id = t.contact_id AND c.clicked_at <= t.sent_at) AS lca
        FROM lb_target t`);
      await tx.unsafe(`CREATE INDEX ON lb_result (stage_send_id)`);
      await tx.unsafe(`ANALYZE lb_result`);
      lap("last click at send computed");
    });

    const [s] = await db.unsafe(`
      SELECT count(*)::int AS warm_stamps,
             count(*) FILTER (WHERE lca IS NULL)::int AS no_click_found,
             count(*) FILTER (WHERE lca >= sent_at - make_interval(days => ${WARM_SPLIT_DAYS}))::int AS warm_31_60,
             count(*) FILTER (WHERE lca < sent_at - make_interval(days => ${WARM_SPLIT_DAYS}))::int AS warm_61_120,
             count(*) FILTER (WHERE lca >= sent_at - interval '30 days')::int AS within_30d,
             count(*) FILTER (WHERE lca < sent_at - interval '120 days')::int AS beyond_120d
      FROM lb_result`);
    console.log("\nwarm stamps to fill:", s);
    console.log(
      "  within_30d / beyond_120d: warm at evaluation but outside 31–120 measured at sent_at\n" +
        "  (the stamp's status is evaluated before the send). They are still Warm and land in\n" +
        "  31–60 / 61–120 respectively — the stamp, not this script, decides the cohort.",
    );

    if (!APPLY) {
      console.log("\nDRY RUN — re-run with --apply to write.");
      return;
    }

    let cursor = "00000000-0000-0000-0000-000000000000";
    let written = 0;
    for (;;) {
      const res = await db.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = '120s'`);
        await tx.unsafe(`SET LOCAL lock_timeout = '5s'`);
        return tx.unsafe(
          `
          WITH batch AS (
            SELECT stage_send_id, lca FROM lb_result
            WHERE lca IS NOT NULL AND stage_send_id > $1::uuid
            ORDER BY stage_send_id LIMIT $2
          ), upd AS (
            UPDATE stage_send_lifecycle l SET last_click_at = b.lca
            FROM batch b
            WHERE l.stage_send_id = b.stage_send_id AND l.last_click_at IS NULL
            RETURNING 1
          )
          SELECT (SELECT stage_send_id::text FROM batch ORDER BY stage_send_id DESC LIMIT 1) AS last,
                 (SELECT count(*)::int FROM upd) AS n`,
          [cursor, BATCH],
        );
      });
      const last = res[0]?.last as string | null;
      if (!last) break;
      written += Number(res[0].n);
      cursor = last;
      lap(`batch → ${written.toLocaleString()} written`);
    }
    console.log(`\ndone: ${written.toLocaleString()} stamp(s) written`);
  } finally {
    await db.unsafe(`DROP TABLE IF EXISTS lb_result, lb_clicks, lb_target`).catch(() => {});
    await db.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
