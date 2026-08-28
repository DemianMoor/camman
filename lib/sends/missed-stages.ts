import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";

// A stage the scheduler gave up on, whose messages are still sitting there.
//
// ⭐ THIS IS THE BLIND SPOT THE STALL DETECTOR CANNOT SEE, BY CONSTRUCTION.
// findStalledStages excludes `schedule_missed_at IS NOT NULL` on purpose — a
// missed stage is not "failing to drain", it has been formally stood down, so
// it is not a stall. But nothing else looked at it either, so a stage could be
// stood down holding thousands of undispatched messages and NOTHING would ever
// say so. Found on 2026-08-28: stage 3272 (142_118_082626_2_s1_c600) had sat
// missed for 35 hours with 2,000 pending rows and zero sends. It was missed
// because Text Request was at its 24h ceiling when its slot came up and the ET
// window closed before headroom returned — an ordinary, recoverable situation
// that silently cost a whole stage.
//
// Read-only. Alerts are LATCHED per stage (alert_state, migration 0154) because
// a missed stage stays missed until a human reschedules it: an unlatched check
// on an hourly cron would repeat the same alert every hour forever, which is
// how alerts get muted and then ignored.

const ALERT_PREFIX = "missed_stage:stage:";
const alertKey = (stageId: number) => `${ALERT_PREFIX}${stageId}`;

export interface MissedStage {
  stage_id: number;
  org_id: string;
  campaign: string;
  stage_number: number | null;
  label: string | null;
  tracking_id: string | null;
  provider_name: string | null;
  scheduled_at: string | null;
  schedule_missed_at: string | null;
  pending: number;
}

/**
 * Stages standing down with undispatched rows.
 *
 * Scoped to `campaigns.status = 'active'` deliberately: the drain filters on the
 * same value in both phases, so a stage under a completed/archived campaign can
 * never send no matter what — that is a different (and permanent) problem, and
 * alerting on it would nag about rows no reschedule can revive.
 */
export async function findMissedStages(
  dbc: typeof db,
  opts: { orgId?: string } = {},
): Promise<MissedStage[]> {
  const { orgId } = opts;
  const rows = (await dbc.execute(sql`
    SELECT s.id              AS stage_id,
           c.org_id          AS org_id,
           c.name            AS campaign,
           s.stage_number    AS stage_number,
           s.label           AS label,
           s.tracking_id     AS tracking_id,
           p.name            AS provider_name,
           s.scheduled_at    AS scheduled_at,
           s.schedule_missed_at AS schedule_missed_at,
           (SELECT count(*)::int FROM stage_sends ss
              WHERE ss.stage_id = s.id AND ss.status = 'pending') AS pending
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE s.schedule_missed_at IS NOT NULL
      AND s.archived_at IS NULL
      AND c.status = 'active'
      AND EXISTS (
        SELECT 1 FROM stage_sends ss
        WHERE ss.stage_id = s.id AND ss.status = 'pending'
      )
      ${orgId ? sql`AND c.org_id = ${orgId}` : sql``}
    ORDER BY s.schedule_missed_at ASC
  `)) as unknown as MissedStage[];
  // The `pending` scalar subquery is safe here (unlike the one that caused the
  // 2026-08-27 outage): it filters on status = 'pending', which is served by the
  // partial index stage_sends_pending_idx with stage_id as an Index Cond. The
  // pathological shape was max(sent_at), whose only index leads with sent_at.
  return rows.map((r) => ({ ...r, pending: Number(r.pending ?? 0) }));
}

export function formatMissedStageAlert(s: MissedStage, now: Date): string {
  const stageBit = s.stage_number != null ? `stage ${s.stage_number}` : `stage id ${s.stage_id}`;
  const labelBit = s.label ? ` "${s.label}"` : "";
  const trackBit = s.tracking_id ? ` [${s.tracking_id}]` : "";
  const missedAgo = s.schedule_missed_at
    ? `${Math.round((now.getTime() - new Date(s.schedule_missed_at).getTime()) / 3_600_000)}h ago`
    : "at an unknown time";
  return (
    `⏸ Stage STOOD DOWN with messages still queued — "${s.campaign}" · ${stageBit}${labelBit}${trackBit}\n` +
    `${s.pending} message(s) never dispatched. Marked missed ${missedAgo} ` +
    `(scheduled ${s.scheduled_at ?? "?"}, provider ${s.provider_name ?? "?"}).\n` +
    `These will NOT send on their own — the scheduler has stood the stage down. ` +
    `Reschedule it, or cancel the remaining rows.`
  );
}

/**
 * Alert once per newly-missed stage; re-arm when it stops being missed-with-rows.
 *
 * The clear half is not optional. A latched alert nobody resets fires once and
 * then goes permanently quiet for that stage — so a stage rescheduled today and
 * missed again next week would be silent. Any key still `firing` that is no
 * longer in the current set is cleared, which is what makes the NEXT occurrence
 * audible.
 */
export async function reportMissedStages(
  dbc: typeof db,
  opts: {
    now: Date;
    orgId?: string;
    /** Injectable ONLY so the guard can assert latch behaviour without the network. */
    send?: (text: string) => Promise<boolean>;
  },
): Promise<MissedStage[]> {
  const missed = await findMissedStages(dbc, { orgId: opts.orgId });
  const live = new Set(missed.map((m) => m.stage_id));

  for (const m of missed) {
    await notifyOnTransition(dbc, {
      alertKey: alertKey(m.stage_id),
      orgId: m.org_id,
      text: formatMissedStageAlert(m, opts.now),
      ...(opts.send ? { send: opts.send } : {}),
    });
  }

  const firing = (await dbc.execute(sql`
    SELECT alert_key FROM alert_state
    WHERE alert_key LIKE ${ALERT_PREFIX + "%"} AND state = 'firing'
  `)) as unknown as { alert_key: string }[];
  for (const row of firing) {
    const id = Number(row.alert_key.slice(ALERT_PREFIX.length));
    if (!Number.isFinite(id) || live.has(id)) continue;
    await clearAlert(dbc, { alertKey: row.alert_key });
  }

  return missed;
}
