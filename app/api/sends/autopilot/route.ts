import { NextResponse } from "next/server";
import { inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { stage_sends } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { sendWindowForDay } from "@/lib/quiet-hours";
import { deriveStageOperationalStatus } from "@/lib/stages/stage-status";

// P6 — Autopilot weekly view. One cross-campaign screen of every tracked stage
// scheduled in the coming week (plus yesterday's sent/missed for context), with
// the P4 slip state (slip_count, original vs current schedule, hold + reason),
// the parent-complete gate status for lane children, and the persisted P5
// preflight breakdown (resolved-audience ETA + exclusion counts). Read-only.
//
// Window: `scheduled_at` in [now − 1 day, now + 7 days], OR sent/missed in the
// last day (recent context). Tracked, non-archived stages only.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "stages.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const rows = (await db.execute(sql`
    SELECT
      s.id              AS stage_id,
      s.stage_number    AS stage_number,
      s.label           AS label,
      s.scheduled_at    AS scheduled_at,
      s.sent_at         AS sent_at,
      s.materialized_at AS materialized_at,
      s.schedule_missed_at AS schedule_missed_at,
      s.send_approved   AS send_approved,
      s.status          AS status,
      s.tracking_id     AS tracking_id,
      s.behavioral_tier AS behavioral_tier,
      s.parent_stage_id AS parent_stage_id,
      s.slip_count      AS slip_count,
      s.slip_original_scheduled_at AS slip_original_scheduled_at,
      s.slip_hold_at    AS slip_hold_at,
      s.slip_hold_reason AS slip_hold_reason,
      s.preflight_result AS preflight_result,
      s.preflight_computed_at AS preflight_computed_at,
      s.preflight_aborted_at  AS preflight_aborted_at,
      c.id              AS campaign_id,
      c.name            AS campaign_name,
      c.link_mode       AS link_mode,
      p.name            AS provider_name,
      p.color           AS provider_color,
      p.send_paused     AS provider_paused,
      p.send_window_weekday_start AS w_wd_start,
      p.send_window_weekday_end   AS w_wd_end,
      p.send_window_weekend_start AS w_we_start,
      p.send_window_weekend_end   AS w_we_end,
      -- Parent-complete gate for lane children: sent_at set AND no open (pending/
      -- sending) rows on the parent. NULL for non-lane stages.
      CASE WHEN s.parent_stage_id IS NULL THEN NULL ELSE (
        SELECT (par.sent_at IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM stage_sends ss
          WHERE ss.stage_id = par.id AND ss.status IN ('pending','sending')
        ))
        FROM campaign_stages par WHERE par.id = s.parent_stage_id
      ) END AS parent_complete
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id AND c.org_id = ${orgId}
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id AND p.org_id = ${orgId}
    WHERE s.org_id = ${orgId}
      AND s.status <> 'archived'
      AND c.link_mode = 'tracked'
      AND (
        (s.scheduled_at >= now() - interval '1 day' AND s.scheduled_at <= now() + interval '7 days')
        OR s.sent_at >= now() - interval '1 day'
        OR s.schedule_missed_at >= now() - interval '1 day'
        OR s.slip_hold_at IS NOT NULL
      )
    ORDER BY s.scheduled_at ASC NULLS LAST, s.id ASC
  `)) as unknown as AutopilotRow[];

  if (rows.length === 0) return NextResponse.json({ data: [], counts: {} });

  const stageIds = rows.map((r) => Number(r.stage_id));
  const countRows = (await db.execute(sql`
    SELECT stage_id,
      count(*) FILTER (WHERE status <> 'rejected')::int AS total,
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'sending')::int AS sending,
      count(*) FILTER (WHERE status = 'sent')::int AS sent,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      count(*) FILTER (WHERE status = 'skipped_duplicate')::int AS skipped_duplicate,
      count(*) FILTER (WHERE status = 'skipped_opted_out')::int AS skipped_opted_out
    FROM stage_sends
    WHERE org_id = ${orgId} AND ${inArray(stage_sends.stage_id, stageIds)}
    GROUP BY stage_id
  `)) as unknown as CountRow[];
  const countsByStage = new Map(
    countRows.map((r) => [
      Number(r.stage_id),
      {
        total: Number(r.total), pending: Number(r.pending), sending: Number(r.sending),
        sent: Number(r.sent), failed: Number(r.failed),
        skippedDuplicate: Number(r.skipped_duplicate), skippedOptedOut: Number(r.skipped_opted_out),
      },
    ]),
  );

  const data = rows.map((r) => {
    const counts = countsByStage.get(Number(r.stage_id)) ?? {
      total: 0, pending: 0, sending: 0, sent: 0, failed: 0, skippedDuplicate: 0, skippedOptedOut: 0,
    };
    const op =
      deriveStageOperationalStatus({
        linkMode: r.link_mode,
        status: r.status,
        scheduledAt: r.scheduled_at,
        sentAt: r.sent_at,
        scheduleMissedAt: r.schedule_missed_at,
        slipHoldAt: r.slip_hold_at,
        materializedAt: r.materialized_at,
        counts,
      }) ?? "draft";

    let windowOpensAt: string | null = null;
    let windowClosesAt: string | null = null;
    if (r.scheduled_at && !r.sent_at) {
      const { open, close } = sendWindowForDay(
        {
          send_window_weekday_start: r.w_wd_start,
          send_window_weekday_end: r.w_wd_end,
          send_window_weekend_start: r.w_we_start,
          send_window_weekend_end: r.w_we_end,
        },
        new Date(r.scheduled_at),
      );
      windowOpensAt = open.toISOString();
      windowClosesAt = close.toISOString();
    }

    return {
      stage_id: Number(r.stage_id),
      stage_number: r.stage_number,
      label: r.label,
      campaign_id: Number(r.campaign_id),
      campaign_name: r.campaign_name,
      tracking_id: r.tracking_id,
      scheduled_at: r.scheduled_at,
      sent_at: r.sent_at,
      schedule_missed_at: r.schedule_missed_at,
      provider_name: r.provider_name,
      provider_color: r.provider_color,
      provider_paused: r.provider_paused === true,
      operational_status: op,
      counts,
      window_opens_at: windowOpensAt,
      window_closes_at: windowClosesAt,
      // Lane / slip / gate
      is_lane_child: r.parent_stage_id != null,
      behavioral_tier: r.behavioral_tier,
      parent_stage_id: r.parent_stage_id,
      parent_complete: r.parent_complete,
      slip_count: r.slip_count,
      slip_original_scheduled_at: r.slip_original_scheduled_at,
      slip_hold_at: r.slip_hold_at,
      slip_hold_reason: r.slip_hold_reason,
      // Preflight
      preflight_result: r.preflight_result,
      preflight_computed_at: r.preflight_computed_at,
      preflight_aborted_at: r.preflight_aborted_at,
    };
  });

  // Health tiles by operational status.
  const counts: Record<string, number> = {};
  for (const d of data) counts[d.operational_status] = (counts[d.operational_status] ?? 0) + 1;

  return NextResponse.json({ data, counts });
}

interface AutopilotRow {
  stage_id: number;
  stage_number: number;
  label: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  materialized_at: string | null;
  schedule_missed_at: string | null;
  send_approved: boolean;
  status: string;
  tracking_id: string | null;
  behavioral_tier: number | null;
  parent_stage_id: number | null;
  slip_count: number;
  slip_original_scheduled_at: string | null;
  slip_hold_at: string | null;
  slip_hold_reason: string | null;
  preflight_result: unknown;
  preflight_computed_at: string | null;
  preflight_aborted_at: string | null;
  campaign_id: number;
  campaign_name: string;
  link_mode: string;
  provider_name: string | null;
  provider_color: string | null;
  provider_paused: boolean | null;
  w_wd_start: number | null;
  w_wd_end: number | null;
  w_we_start: number | null;
  w_we_end: number | null;
  parent_complete: boolean | null;
}

interface CountRow {
  stage_id: number;
  total: number;
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  skipped_duplicate: number;
  skipped_opted_out: number;
}
