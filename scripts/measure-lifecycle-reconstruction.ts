import "./_env-preload";

// READ-ONLY measurement of ONE ET day's lifecycle reconstruction (PR 5).
// ⭐ Everything runs inside a transaction that ALWAYS rolls back, and the only
// tables it creates are TEMP … ON COMMIT DROP. Nothing is written.
//
// ── WHAT IT IS MEASURING, AND WHY IT HAS TO BE A REPLAY ─────────────────────
// The reconstruction needs each recipient's status AS OF a past moment.
// Neither obvious source can supply that:
//   * contact_engagement holds only CURRENT rollups — it cannot say what
//     msgs_total was on 13 August;
//   * contact_engagement_transitions begins 2026-09-23 09:19 (the backfill
//     instant), which is AFTER every row this targets.
// So the as-of facts are replayed from raw `stage_sends` + `counted_clickers`,
// exactly the way lib/engagement/refresh.ts builds `eng_facts`/`eng_clicks`
// with its `asOf` parameter, and fed to the ONE evaluator,
// `evaluationSelectSql`. No threshold comparison is re-spelled here.
//
// ⚠️ AS OF THE DAY BOUNDARY, NOT EACH SEND'S TIMESTAMP. The spec says "as of
// sent_at"; evaluating per send means one evaluation per distinct timestamp,
// which at ~100K sends/day is not a batch job, it is 100K of them. This
// measures the day-boundary approximation the "batches of one ET day" wording
// implies. A contact messaged many times within one day therefore carries ONE
// status for that day — the plan must state that as the accepted meaning, or
// choose differently with this number in hand.
//
// Run in the quiet window (~05:00-06:00 UTC), per the heavy-prod convention.
// Run: npx tsx --conditions=react-server scripts/measure-lifecycle-reconstruction.ts [--day YYYY-MM-DD]

import { sql } from "drizzle-orm";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

async function main() {
  const { db } = await import("@/db/client");
  const { evaluationSelectSql } = await import("@/lib/engagement/status-sql");
  const { createThresholdTempTables } =
    await import("@/lib/engagement/thresholds-sql");
  // ⚠️ HUMAN_CLICK is the ONE definition of a human click (bot/prefetch/
  // unscored excluded). Re-spelling it here would silently reconstruct a
  // different history than the job produces.
  const { HUMAN_CLICK } = await import("@/lib/reporting/counted-clickers");

  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x")
    .hostname;
  const started = new Date();
  console.log(`measuring against ${host} — READ ONLY, always rolled back`);
  console.log(
    `started ${started.toISOString()} (minute :${started.getUTCMinutes()})\n`,
  );

  const orgs = (await db.execute(
    sql`SELECT id FROM organizations ORDER BY created_at`,
  )) as unknown as { id: string }[];
  if (orgs.length !== 1) throw new Error(`${orgs.length} orgs — assumes one`);
  const orgId = orgs[0].id;

  // Pick a MID-SIZE day: the median of the last 60, not a peak. A peak day
  // measures the worst case and a quiet day flatters it; the median is what
  // 54 batches will mostly look like.
  let day = arg("day");
  if (!day) {
    const days = (await db.execute(sql`
      SELECT (sent_at AT TIME ZONE 'America/New_York')::date::text AS et_day,
             count(*)::int AS sends
      FROM stage_sends
      WHERE status = 'sent' AND sent_at > now() - interval '60 days'
      GROUP BY 1 HAVING count(*) > 0 ORDER BY 2
    `)) as unknown as { et_day: string; sends: number }[];
    const mid = days[Math.floor(days.length / 2)];
    day = mid.et_day;
    console.log(
      `picked the MEDIAN ET day of ${days.length}: ${day} (${mid.sends.toLocaleString()} sends)\n` +
        `  range across the window: ${days[0].sends.toLocaleString()} … ${days[days.length - 1].sends.toLocaleString()}\n`,
    );
  }

  const t = (label: string, ms: number) =>
    console.log(
      `  ${label.padEnd(34)} ${Math.round(ms).toLocaleString().padStart(9)} ms`,
    );

  await db
    .transaction(async (tx) => {
      const org = sql`${orgId}::uuid`;
      // The instant we evaluate as of: the END of that ET day, so every send
      // in the day is covered by facts up to it.
      const asOf = sql`((${day}::date + 1) AT TIME ZONE 'America/New_York')`;
      let m = performance.now();

      // The day's sent rows — the reconstruction's target set.
      await tx.execute(sql`
        CREATE TEMP TABLE rc_target ON COMMIT DROP AS
        SELECT ss.id AS stage_send_id, ss.contact_id
        FROM stage_sends ss
        WHERE ss.org_id = ${org} AND ss.status = 'sent'
          AND (ss.sent_at AT TIME ZONE 'America/New_York')::date = ${day}::date`);
      await tx.execute(sql`ANALYZE rc_target`);
      t("target rows", performance.now() - m);
      const tgt = (await tx.execute(
        sql`SELECT count(*)::int AS n, count(DISTINCT contact_id)::int AS c FROM rc_target`,
      )) as unknown as { n: number; c: number }[];
      console.log(
        `    ${tgt[0].n.toLocaleString()} sends · ${tgt[0].c.toLocaleString()} distinct contacts\n`,
      );

      // ── the replay: clicks, then facts, both AS OF ────────────────────────
      m = performance.now();
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
      t("clicks as-of", performance.now() - m);

      m = performance.now();
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
      t("facts as-of (the heavy one)", performance.now() - m);

      m = performance.now();
      await createThresholdTempTables(tx, orgId);
      t("thresholds", performance.now() - m);

      // ⚠️ prev_status is NULL by construction: there is no prior state to
      // carry for a reconstructed day, so the evaluator is given 'backfill'
      // as the initial reason — the same one PR 1's backfill used.
      m = performance.now();
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
      t("eval input", performance.now() - m);

      m = performance.now();
      await tx.execute(sql`
        CREATE TEMP TABLE rc_final ON COMMIT DROP AS
        ${evaluationSelectSql(sql`rc_eval`, asOf, "backfill")}`);
      t("EVALUATE (the one evaluator)", performance.now() - m);

      // ── the result ────────────────────────────────────────────────────────
      const dist = (await tx.execute(sql`
        SELECT r.status, count(*)::int AS contacts,
               (SELECT count(*)::int FROM rc_target t2
                 JOIN rc_final f2 ON f2.contact_id = t2.contact_id
                WHERE f2.status = r.status) AS sends
        FROM rc_final r GROUP BY r.status ORDER BY 2 DESC`)) as unknown as Record<
        string,
        unknown
      >[];
      console.log("\n  status distribution for the day:");
      console.log("  " + JSON.stringify(dist));

      const unclassified = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM rc_target t
        WHERE NOT EXISTS (SELECT 1 FROM rc_final f WHERE f.contact_id = t.contact_id)`)) as unknown as {
        n: number;
      }[];
      console.log(
        `\n  ⚠️ unclassified sends: ${unclassified[0].n.toLocaleString()}` +
          ` (a contact with no sent row at or before the as-of instant)`,
      );

      const suppressed = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM rc_final WHERE status = 'suppressed'`,
      )) as unknown as { n: number }[];
      console.log(
        `  ⚠️ evaluated as 'suppressed': ${suppressed[0].n.toLocaleString()}` +
          ` — spec §10 says reconstruction NEVER writes suppressed, so these become their prior status`,
      );

      throw new Error("__ROLLBACK__");
    })
    .catch((e) => {
      if (!(e instanceof Error) || e.message !== "__ROLLBACK__") throw e;
    });

  const secs = (Date.now() - started.getTime()) / 1000;
  console.log(`\nONE DAY took ${secs.toFixed(1)}s.`);
  console.log(
    `Extrapolated to 54 ET days: ~${((secs * 54) / 60).toFixed(1)} min of pure compute` +
      ` (plus the writes a real backfill does, which this does not measure).`,
  );
  console.log("\nRolled back. Nothing was written.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
