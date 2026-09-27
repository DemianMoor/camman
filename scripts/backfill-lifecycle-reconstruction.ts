import "./_env-preload";

// THE 60-DAY LIFECYCLE RECONSTRUCTION (PR 5 Task 1).
//
// Fills stage_send_lifecycle for the sends that predate live stamping, so the
// Lifecycle report has cohorts for periods before 2026-09-24.
//
// ⭐ DRY RUN BY DEFAULT. `--apply` writes. Without it nothing is written and
// every day is reported.
//
// ── WHY THIS IS A REPLAY AND NOT A LOOKUP ───────────────────────────────────
// Each send needs the recipient's status AS OF a past moment, and neither
// obvious source can supply that:
//   * contact_engagement holds only CURRENT rollups — it cannot say what
//     msgs_total was on 13 August;
//   * contact_engagement_transitions begins 2026-09-23 09:19 (the PR 1
//     backfill instant), which is AFTER every row this targets.
// So the facts are replayed from raw stage_sends + clicks/links and fed to the
// ONE evaluator, evaluationSelectSql. No threshold comparison is re-spelled
// here, and HUMAN_CLICK is imported rather than retyped.
//
// ── DAY-BOUNDARY, BY DECISION ───────────────────────────────────────────────
// One status per contact per ET day, evaluated as of that day's end (owner,
// 2026-09-27). Evaluating per send would be ~71K evaluations for a median day
// instead of one. A contact messaged repeatedly within a day therefore carries
// ONE status for that day, and the page says so.
//
// ── ⚠️ A ONE-SHOT ARTIFACT ──────────────────────────────────────────────────
// It uses CURRENT thresholds, and it is NOT re-run after a threshold change
// (owner, 2026-09-27). Re-running later would produce different history for
// the same day. The page's reconstruction note states the thresholds in force
// on the day it ran; nothing is recorded per row. So: run it once, and record
// what the thresholds were.
//
// ── SUPPRESSED IS NEVER WRITTEN ─────────────────────────────────────────────
// Spec §10. Suppression could not have happened before launch, so emitting it
// would be inventing history. Coerced rows are counted and reported.
//
// Run:
//   npx tsx --conditions=react-server scripts/backfill-lifecycle-reconstruction.ts
//   npx tsx --conditions=react-server scripts/backfill-lifecycle-reconstruction.ts --apply

import { sql } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const DAYS_BACK = Number(arg("days") ?? "60");
const ONLY_DAY = arg("day");
const MAX_DAYS = Number(arg("max-days") ?? "0") || Infinity;
const ONLY_ORG = arg("org");

interface DayResult {
  day: string;
  sends: number;
  unstamped: number;
  written: number;
  byStatus: Record<string, number>;
  suppressedCoerced: number;
  unclassified: number;
  ms: number;
  skipped: boolean;
}

async function main() {
  const { db } = await import("@/db/client");
  const { evaluationSelectSql } = await import("@/lib/engagement/status-sql");
  const { createThresholdTempTables } = await import(
    "@/lib/engagement/thresholds-sql"
  );
  const { HUMAN_CLICK } = await import("@/lib/reporting/counted-clickers");
  const { etDayBounds } = await import("@/lib/reporting/delivery-rollup");
  const { loadLifecycleSettings } = await import("@/lib/engagement/settings-io");

  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x")
    .hostname;
  const started = new Date();
  console.log(
    `${APPLY ? "⚠️  APPLY" : "DRY RUN"} against ${host}` +
      `${APPLY ? " — THIS WRITES" : " — nothing will be written"}`,
  );
  console.log(`started ${started.toISOString()}\n`);

  // Production has exactly one org and the assertion is the guard against a
  // run that would silently reconstruct only part of the data. `--org` exists
  // for the preview bar, which adds a throwaway org alongside the existing one.
  let orgId = ONLY_ORG;
  if (!orgId) {
    const orgs = (await db.execute(
      sql`SELECT id FROM organizations ORDER BY created_at`,
    )) as unknown as { id: string }[];
    if (orgs.length !== 1) throw new Error(`${orgs.length} orgs — assumes one`);
    orgId = orgs[0].id;
  }

  // ⚠️ Record the thresholds this run used. They are not stored per row, so
  // this line is the only record of what the reconstruction meant.
  const thr = await loadLifecycleSettings(db, orgId);
  console.log(
    `thresholds in force for THIS run (not stored per row — see the header):\n` +
      `  hot_days=${thr.hot_days} warm_days=${thr.warm_days} ` +
      `freeze_after_messages=${thr.freeze_after_messages} ` +
      `freeze_cadence_days=${thr.freeze_cadence_days} ` +
      `suppress_after_days=${thr.suppress_after_days} ` +
      `suppress_min_freeze_messages=${thr.suppress_min_freeze_messages}\n`,
  );

  // Candidate ET days, oldest first so a partial run leaves a contiguous tail.
  const days = (await db.execute(sql`
    SELECT (ss.sent_at AT TIME ZONE 'America/New_York')::date::text AS et_day,
           count(*)::int AS sends,
           count(*) FILTER (
             WHERE NOT EXISTS (
               SELECT 1 FROM stage_send_lifecycle l WHERE l.stage_send_id = ss.id
             )
           )::int AS unstamped
    FROM stage_sends ss
    WHERE ss.status = 'sent'
      ${ONLY_ORG ? sql`AND ss.org_id = ${ONLY_ORG}::uuid` : sql``}
      AND ss.sent_at > now() - make_interval(days => ${DAYS_BACK}::int)
      ${ONLY_DAY ? sql`AND (ss.sent_at AT TIME ZONE 'America/New_York')::date = ${ONLY_DAY}::date` : sql``}
    GROUP BY 1 ORDER BY 1
  `)) as unknown as { et_day: string; sends: number; unstamped: number }[];

  console.log(
    `${days.length} ET day(s) in the window, ` +
      `${days.reduce((a, d) => a + d.sends, 0).toLocaleString()} sends, ` +
      `${days.reduce((a, d) => a + d.unstamped, 0).toLocaleString()} unstamped\n`,
  );

  const results: DayResult[] = [];
  let processed = 0;

  for (const d of days) {
    if (processed >= MAX_DAYS) break;
    // ⚠️ RESUME IS DERIVED FROM THE DATA, not from a cursor file. A cursor
    // lies after a partial failure; "every sent row in this day already has a
    // stamp" cannot.
    if (d.unstamped === 0) {
      results.push({
        day: d.et_day, sends: d.sends, unstamped: 0, written: 0,
        byStatus: {}, suppressedCoerced: 0, unclassified: 0, ms: 0, skipped: true,
      });
      continue;
    }
    processed++;
    const t0 = performance.now();
    const r: Omit<DayResult, "day" | "sends" | "unstamped" | "ms" | "skipped"> = {
      written: 0, byStatus: {}, suppressedCoerced: 0, unclassified: 0,
    };

    // ONE TRANSACTION PER ET DAY, so a failure loses one day, not the run.
    await db.transaction(async (tx) => {
      const org = sql`${orgId}::uuid`;
      // ⚠️ THE DAY'S END, COMPUTED IN JS BY THE SHARED HELPER. Written as
      // `(<date> + 1) AT TIME ZONE 'America/New_York'` in SQL it lands EIGHT
      // HOURS EARLY — Postgres casts the date to timestamptz in the session
      // zone, converts TO ET, and returns a naive timestamp compared as UTC, so
      // asOf was 16:00 ET. Every day was then evaluated against truncated
      // message counts and clicks, and every send after 16:00 ET fell out of
      // the facts entirely and reconstructed to nothing.
      const asOf = sql`${etDayBounds({
        from: d.et_day,
        to: d.et_day,
      }).toExclusiveUtc.toISOString()}::timestamptz`;

      await tx.execute(sql`
        CREATE TEMP TABLE rc_target ON COMMIT DROP AS
        SELECT ss.id AS stage_send_id, ss.contact_id
        FROM stage_sends ss
        WHERE ss.org_id = ${org} AND ss.status = 'sent'
          AND (ss.sent_at AT TIME ZONE 'America/New_York')::date = ${d.et_day}::date
          AND NOT EXISTS (
            SELECT 1 FROM stage_send_lifecycle l WHERE l.stage_send_id = ss.id
          )`);
      await tx.execute(sql`ANALYZE rc_target`);

      await tx.execute(sql`
        CREATE TEMP TABLE rc_clicks ON COMMIT DROP AS
        SELECT l.contact_id,
               min(ck.clicked_at) AS first_click_at,
               max(ck.clicked_at) AS last_click_at
        FROM clicks ck
        JOIN links l ON l.id = ck.link_id
        WHERE ${HUMAN_CLICK} AND ck.org_id = ${org}
          AND ck.clicked_at <= ${asOf} AND ck.scored_at <= ${asOf}
          AND l.contact_id IN (SELECT contact_id FROM rc_target)
        GROUP BY l.contact_id`);
      await tx.execute(sql`ANALYZE rc_clicks`);

      await tx.execute(sql`
        CREATE TEMP TABLE rc_facts ON COMMIT DROP AS
        SELECT ss.contact_id,
               count(*)::int AS msgs_total,
               count(*) FILTER (WHERE cl.last_click_at IS NULL OR ss.sent_at > cl.last_click_at)::int AS msgs_since_click,
               count(*) FILTER (WHERE ss.sent_at > ${asOf} - interval '7 days')::int AS msgs_7d,
               count(*) FILTER (WHERE ss.sent_at > ${asOf} - interval '14 days')::int AS msgs_14d,
               count(*) FILTER (WHERE ss.sent_at > ${asOf} - interval '30 days')::int AS msgs_30d,
               count(*) FILTER (WHERE ss.sent_at > ${asOf} - interval '90 days')::int AS msgs_90d,
               min(ss.sent_at) AS first_sent_at,
               max(ss.sent_at) AS last_sent_at
        FROM stage_sends ss
        LEFT JOIN rc_clicks cl ON cl.contact_id = ss.contact_id
        WHERE ss.org_id = ${org} AND ss.status = 'sent' AND ss.sent_at <= ${asOf}
          AND ss.contact_id IN (SELECT contact_id FROM rc_target)
        GROUP BY ss.contact_id`);
      await tx.execute(sql`ANALYZE rc_facts`);

      await createThresholdTempTables(tx, orgId);

      await tx.execute(sql`
        CREATE TEMP TABLE rc_eval ON COMMIT DROP AS
        SELECT f.contact_id,
               NULL::text AS prev_status,
               NULL::timestamptz AS prev_status_changed_at,
               NULL::timestamptz AS prev_freeze_entered_at,
               f.msgs_total, f.msgs_since_click,
               f.msgs_7d, f.msgs_14d, f.msgs_30d, f.msgs_90d,
               f.first_sent_at, f.last_sent_at,
               cl.first_click_at, cl.last_click_at,
               NULL::timestamptz AS calc_freeze_started_at,
               0::int AS calc_freeze_msgs,
               o.hot_days, o.warm_days,
               coalesce(g.freeze_after_messages, o.freeze_after_messages) AS freeze_after_messages,
               coalesce(g.freeze_cadence_days, o.freeze_cadence_days) AS freeze_cadence_days,
               coalesce(g.suppress_after_days, o.suppress_after_days) AS suppress_after_days,
               coalesce(g.suppress_min_freeze_messages, o.suppress_min_freeze_messages) AS suppress_min_freeze_messages,
               coalesce(g.override_group_ids, '{}'::int[]) AS override_group_ids
        FROM rc_facts f
        LEFT JOIN rc_clicks cl ON cl.contact_id = f.contact_id
        LEFT JOIN eng_grp_thr g ON g.contact_id = f.contact_id
        CROSS JOIN eng_org_thr o`);
      await tx.execute(sql`ANALYZE rc_eval`);

      await tx.execute(sql`
        CREATE TEMP TABLE rc_final ON COMMIT DROP AS
        ${evaluationSelectSql(sql`rc_eval`, asOf, "backfill")}`);

      // ⚠️ SUPPRESSED IS NEVER WRITTEN (spec §10). A contact the facts imply is
      // suppressed becomes 'freeze' — the status they must have been in to get
      // there — because suppression could not have happened before launch.
      const coerced = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM rc_final WHERE status = 'suppressed'`)) as unknown as { n: number }[];
      r.suppressedCoerced = Number(coerced[0]?.n ?? 0);

      const dist = (await tx.execute(sql`
        SELECT CASE WHEN f.status = 'suppressed' THEN 'freeze' ELSE f.status END AS status,
               count(*)::int AS n
        FROM rc_target t JOIN rc_final f ON f.contact_id = t.contact_id
        GROUP BY 1`)) as unknown as { status: string; n: number }[];
      r.byStatus = Object.fromEntries(dist.map((x) => [x.status, Number(x.n)]));

      const unclass = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM rc_target t
        WHERE NOT EXISTS (SELECT 1 FROM rc_final f WHERE f.contact_id = t.contact_id)`)) as unknown as { n: number }[];
      r.unclassified = Number(unclass[0]?.n ?? 0);

      if (APPLY) {
        const ins = (await tx.execute(sql`
          INSERT INTO stage_send_lifecycle (stage_send_id, org_id, status, reconstructed)
          SELECT t.stage_send_id, ${org},
                 CASE WHEN f.status = 'suppressed' THEN 'freeze' ELSE f.status END,
                 true
          FROM rc_target t JOIN rc_final f ON f.contact_id = t.contact_id
          ON CONFLICT (stage_send_id) DO NOTHING
          RETURNING stage_send_id`)) as unknown as unknown[];
        r.written = ins.length;
      } else {
        // Dry run: what WOULD be written.
        r.written = Object.values(r.byStatus).reduce((a, b) => a + b, 0);
        throw new Error("__ROLLBACK__");
      }
    }).catch((e) => {
      if (!(e instanceof Error) || e.message !== "__ROLLBACK__") throw e;
    });

    const res: DayResult = {
      day: d.et_day, sends: d.sends, unstamped: d.unstamped,
      ms: performance.now() - t0, skipped: false, ...r,
    };
    results.push(res);
    const parts = Object.entries(res.byStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v.toLocaleString()}`)
      .join(" · ");
    console.log(
      `${res.day}  ${String(res.unstamped).padStart(7)} unstamped  ` +
        `${String(Math.round(res.ms)).padStart(6)} ms  ${parts}` +
        (res.suppressedCoerced ? `  ⚠️ ${res.suppressedCoerced} suppressed→freeze` : "") +
        (res.unclassified ? `  ⚠️ ${res.unclassified} unclassified` : ""),
    );
  }

  // ── the report ───────────────────────────────────────────────────────────
  const done = results.filter((x) => !x.skipped);
  const skipped = results.filter((x) => x.skipped);
  const totalWritten = done.reduce((a, x) => a + x.written, 0);
  const totalMs = done.reduce((a, x) => a + x.ms, 0);
  const totals: Record<string, number> = {};
  for (const x of done)
    for (const [k, v] of Object.entries(x.byStatus)) totals[k] = (totals[k] ?? 0) + v;

  console.log(`\n${"─".repeat(64)}`);
  console.log(
    `days processed ${done.length}, already complete ${skipped.length}` +
      `\nrows ${APPLY ? "WRITTEN" : "that WOULD be written"}: ${totalWritten.toLocaleString()}` +
      `\ntime ${(totalMs / 1000).toFixed(1)}s (${(totalMs / 60000).toFixed(1)} min)`,
  );
  console.log(
    `distribution: ` +
      Object.entries(totals).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v.toLocaleString()}`).join(" · "),
  );
  const coercedTotal = done.reduce((a, x) => a + x.suppressedCoerced, 0);
  const unclassTotal = done.reduce((a, x) => a + x.unclassified, 0);
  console.log(
    `suppressed coerced to freeze: ${coercedTotal.toLocaleString()}` +
      `   unclassified: ${unclassTotal.toLocaleString()}`,
  );
  if (!APPLY) {
    console.log(
      `\nDRY RUN — nothing was written. Re-run with --apply, off-peak, ` +
        `on the owner's explicit go.`,
    );
  }
  console.log(`finished ${new Date().toISOString()}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
