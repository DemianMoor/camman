import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { isOutsideSendWindow, type ProviderSendWindow } from "@/lib/quiet-hours";

// Phase 3 — backlog-stall detector. A catch-all safety net for ANY reason the
// send queue silently stops draining (head-of-line blocking, a wedged provider,
// a bad deploy, a pooler stall): it flags stages that SHOULD be sending right now
// but have made no send progress for a while. Independent of the specific
// failure — if messages sit undrained, this notices.
//
// Read-only. Meant to run on a slow cadence (the hourly Telegram cron) so a
// persistent stall nags ~hourly without spamming every 5-minute drain tick.

export interface StalledStage {
  stage_id: number;
  campaign: string;
  stage_number: number | null;
  label: string | null;
  tracking_id: string | null;
  provider_name: string | null;
  pending: number;
  last_sent: string | null; // ISO, or null if nothing ever sent
  materialized_at: string | null;
}

interface StallRow extends StalledStage {
  send_window_weekday_start: number | null;
  send_window_weekday_end: number | null;
  send_window_weekend_start: number | null;
  send_window_weekend_end: number | null;
}

// A stage is a stall CANDIDATE (per SQL) when it should be actively draining but
// hasn't sent anything in `thresholdMinutes`:
//   • active tracked campaign, approved, not archived, materialization COMPLETE,
//   • not missed, not lane-held (slip_hold), provider not paused,
//   • org sending on (sends_enabled) and not emergency-paused,
//   • released (sent_at set) OR due for first release (scheduled_at <= now),
//   • materialized > threshold ago (give a fresh stage time to get going),
//   • has `pending` rows, and NO `sent` row in the trailing threshold window.
// The final in-window check (per-provider ET window) is applied in JS so a stage
// legitimately paused for quiet hours is NOT reported as stalled.
export async function findStalledStages(
  dbc: typeof db,
  opts: { now: Date; thresholdMinutes: number; orgId?: string },
): Promise<StalledStage[]> {
  const { now, thresholdMinutes, orgId } = opts;
  const nowIso = now.toISOString();
  const rows = (await dbc.execute(sql`
    SELECT s.id                AS stage_id,
           c.name              AS campaign,
           s.stage_number      AS stage_number,
           s.label             AS label,
           s.tracking_id       AS tracking_id,
           p.name              AS provider_name,
           s.materialized_at   AS materialized_at,
           p.send_window_weekday_start AS send_window_weekday_start,
           p.send_window_weekday_end   AS send_window_weekday_end,
           p.send_window_weekend_start AS send_window_weekend_start,
           p.send_window_weekend_end   AS send_window_weekend_end,
           (SELECT count(*)::int FROM stage_sends ss
              WHERE ss.stage_id = s.id AND ss.status = 'pending') AS pending,
           (SELECT max(ss.sent_at) FROM stage_sends ss
              WHERE ss.stage_id = s.id) AS last_sent
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    JOIN org_settings os ON os.org_id = c.org_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE c.link_mode = 'tracked'
      AND c.status = 'active'
      -- P7/P8: don't flag a campaign-paused stage as "stalled" (it's intentionally held).
      AND (c.send_paused IS NOT TRUE)
      AND s.send_approved = true
      AND s.archived_at IS NULL
      AND s.materialized_at IS NOT NULL
      AND s.materialized_at < ${nowIso}::timestamptz - make_interval(mins => ${thresholdMinutes})
      AND s.schedule_missed_at IS NULL
      AND s.slip_hold_at IS NULL
      AND (p.send_paused IS NOT TRUE)
      AND os.sends_enabled = true
      AND (os.sends_paused IS NOT TRUE)
      AND (s.sent_at IS NOT NULL OR (s.scheduled_at IS NOT NULL AND s.scheduled_at <= ${nowIso}))
      AND EXISTS (
        SELECT 1 FROM stage_sends ss
        WHERE ss.stage_id = s.id AND ss.status = 'pending'
      )
      AND NOT EXISTS (
        SELECT 1 FROM stage_sends ss
        WHERE ss.stage_id = s.id AND ss.status = 'sent'
          AND ss.sent_at > ${nowIso}::timestamptz - make_interval(mins => ${thresholdMinutes})
      )
      ${orgId ? sql`AND c.org_id = ${orgId}` : sql``}
    ORDER BY s.materialized_at ASC
  `)) as unknown as StallRow[];

  // Quiet-hours guard: a stage whose provider window is currently CLOSED is
  // legitimately holding, not stalled — drop it.
  return rows
    .filter((r) => {
      const cfg: ProviderSendWindow = {
        send_window_weekday_start: r.send_window_weekday_start,
        send_window_weekday_end: r.send_window_weekday_end,
        send_window_weekend_start: r.send_window_weekend_start,
        send_window_weekend_end: r.send_window_weekend_end,
      };
      return !isOutsideSendWindow(cfg, now);
    })
    .map((r) => ({
      stage_id: r.stage_id,
      campaign: r.campaign,
      stage_number: r.stage_number,
      label: r.label,
      tracking_id: r.tracking_id,
      provider_name: r.provider_name,
      pending: Number(r.pending ?? 0),
      last_sent: r.last_sent,
      materialized_at: r.materialized_at,
    }));
}

// Human-readable Telegram alert body for a non-empty stall list. Caller decides
// whether to send (only when the list is non-empty).
export function formatStallAlert(stages: StalledStage[], now: Date, thresholdMinutes: number): string {
  const totalPending = stages.reduce((n, s) => n + s.pending, 0);
  const lines = stages.slice(0, 15).map((s) => {
    const stageBit = s.stage_number != null ? `stage ${s.stage_number}` : `stage id ${s.stage_id}`;
    const labelBit = s.label ? ` "${s.label}"` : "";
    const trackBit = s.tracking_id ? ` [${s.tracking_id}]` : "";
    const lastBit = s.last_sent
      ? `last send ${Math.round((now.getTime() - new Date(s.last_sent).getTime()) / 60000)}m ago`
      : "never sent";
    return `• "${s.campaign}" · ${stageBit}${labelBit}${trackBit} — ${s.pending} pending, ${lastBit} (${s.provider_name ?? "?"})`;
  });
  const more = stages.length > 15 ? `\n…and ${stages.length - 15} more.` : "";
  return (
    `⚠️ Send queue STALLED — ${stages.length} stage(s), ${totalPending} message(s) not draining ` +
    `(no send in ${thresholdMinutes}m, in-window, provider not paused).\n` +
    lines.join("\n") +
    more +
    `\nCheck the send-scheduled cron / provider health. This is the backlog-stall safety net.`
  );
}
