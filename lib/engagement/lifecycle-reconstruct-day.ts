import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { evaluationSelectSql } from "@/lib/engagement/status-sql";
import { createThresholdTempTables } from "@/lib/engagement/thresholds-sql";
import { HUMAN_CLICK } from "@/lib/reporting/counted-clickers";
import { etDayBounds } from "@/lib/reporting/delivery-rollup";

// ONE ET DAY OF THE LIFECYCLE RECONSTRUCTION — status-at-send for sends that
// were never stamped, replayed from raw sends + human clicks and fed to the ONE
// evaluator. Moved here from scripts/backfill-lifecycle-reconstruction.ts
// (2026-10-23) so the script and the one-shot quiet-window cron
// (lib/engagement/lifecycle-backfill-oneshot.ts) run the same SQL. The script's
// header holds the design notes: day-end evaluation (owner, 2026-09-27),
// current thresholds, SUPPRESSED never written.
//
// Runs in the caller's transaction. With `apply: false` it computes and reports
// but writes nothing (the caller rolls back).

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ReconstructDayResult {
  written: number;
  byStatus: Record<string, number>;
  suppressedCoerced: number;
  /** Target sends whose contact produced no evaluated row — stay unstamped. */
  unclassified: number;
  /** Target sends (unstamped, status 'sent', this ET day). */
  target: number;
}

export async function reconstructLifecycleDay(
  tx: Tx,
  opts: { orgId: string; day: string; apply: boolean },
): Promise<ReconstructDayResult> {
  const { orgId, day } = opts;
  const org = sql`${orgId}::uuid`;
  // ⚠️ THE DAY'S BOUNDS, COMPUTED IN JS BY THE SHARED HELPER. Written as
  // `(<date> + 1) AT TIME ZONE 'America/New_York'` in SQL it lands EIGHT HOURS
  // EARLY (see the script header).
  const bounds = etDayBounds({ from: day, to: day });
  const asOf = sql`${bounds.toExclusiveUtc.toISOString()}::timestamptz`;
  const dayStart = sql`${bounds.fromUtc.toISOString()}::timestamptz`;

  await tx.execute(sql`
    CREATE TEMP TABLE rc_target ON COMMIT DROP AS
    SELECT ss.id AS stage_send_id, ss.contact_id
    FROM stage_sends ss
    WHERE ss.org_id = ${org} AND ss.status = 'sent'
      -- ⚠️ A HALF-OPEN RANGE ON RAW sent_at. The expression form
      -- (sent_at AT TIME ZONE …)::date = day wraps the indexed column and
      -- seq-scans all of stage_sends once per day.
      AND ss.sent_at >= ${dayStart} AND ss.sent_at < ${asOf}
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

  // ⚠️ THE CONTACT'S SENDS BY PHONE, NOT BY contact_id ALONE. stage_sends has
  // no contact_id-leading index, so `contact_id IN (target)` seq-scans the
  // whole table; joining through contacts.phone_number reaches
  // stage_sends_org_phone_sent_idx (org_id, phone, sent_at) WHERE status =
  // 'sent'. The same shape the engagement job's incremental recount uses
  // (lib/engagement/refresh.ts), for the same facts.
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
    FROM (SELECT DISTINCT contact_id FROM rc_target) t
    JOIN contacts c ON c.id = t.contact_id AND c.org_id = ${org}
    JOIN stage_sends ss
      ON ss.org_id = ${org} AND ss.phone = c.phone_number
     AND ss.contact_id = t.contact_id AND ss.status = 'sent'
     AND ss.sent_at <= ${asOf}
    LEFT JOIN rc_clicks cl ON cl.contact_id = ss.contact_id
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
  const one = async <T>(q: ReturnType<typeof sql>) =>
    ((await tx.execute(q)) as unknown as T[])[0];
  const coerced = await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM rc_final WHERE status = 'suppressed'`);
  const dist = (await tx.execute(sql`
    SELECT CASE WHEN f.status = 'suppressed' THEN 'freeze' ELSE f.status END AS status,
           count(*)::int AS n
    FROM rc_target t JOIN rc_final f ON f.contact_id = t.contact_id
    GROUP BY 1`)) as unknown as { status: string; n: number }[];
  const unclass = await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM rc_target t
    WHERE NOT EXISTS (SELECT 1 FROM rc_final f WHERE f.contact_id = t.contact_id)`);
  const target = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM rc_target`);

  const byStatus = Object.fromEntries(dist.map((x) => [x.status, Number(x.n)]));
  let written = 0;
  if (opts.apply) {
    const ins = (await tx.execute(sql`
      INSERT INTO stage_send_lifecycle
        (stage_send_id, org_id, status, reconstructed, last_click_at)
      SELECT t.stage_send_id, ${org},
             CASE WHEN f.status = 'suppressed' THEN 'freeze' ELSE f.status END,
             true,
             -- The replayed last human click as of the day's end — the same
             -- instant the status was evaluated at (0220, the Warm split).
             f.last_click_at
      FROM rc_target t JOIN rc_final f ON f.contact_id = t.contact_id
      ON CONFLICT (stage_send_id) DO NOTHING
      RETURNING stage_send_id`)) as unknown as unknown[];
    written = ins.length;
  } else {
    written = Object.values(byStatus).reduce((a, b) => a + b, 0);
  }
  return {
    written,
    byStatus,
    suppressedCoerced: Number(coerced?.n ?? 0),
    unclassified: Number(unclass?.n ?? 0),
    target: Number(target?.n ?? 0),
  };
}
