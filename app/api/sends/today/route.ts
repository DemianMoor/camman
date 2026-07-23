import { NextResponse } from "next/server";
import { inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { stage_sends } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { can } from "@/lib/permissions";
import { sendWindowForDay } from "@/lib/quiet-hours";
import {
  deriveStageOperationalStatus,
  STAGE_STATUS_META,
} from "@/lib/stages/stage-status";

// WS4 §B1 — Fleet "Today" dashboard data. One cross-campaign view of every
// tracked stage in play TODAY (ET): scheduled today, sent today, or missed
// today. Each stage carries its derived §0 operational status so the UI can
// surface Orange (not prepared) and Red (needs attention) to the top — triage
// from one screen instead of opening many campaign panels. Read-only.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "stages.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const tz = CAMPAIGN_TIMEZONE;

  // Candidate tracked stages whose schedule / send / miss lands on the current
  // ET day. Excludes archived stages and manual-mode campaigns (no pipeline).
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
      c.id              AS campaign_id,
      c.name            AS campaign_name,
      c.link_mode       AS link_mode,
      p.name            AS provider_name,
      p.color           AS provider_color,
      p.send_paused     AS provider_paused,
      p.send_window_weekday_start AS w_wd_start,
      p.send_window_weekday_end   AS w_wd_end,
      p.send_window_weekend_start AS w_we_start,
      p.send_window_weekend_end   AS w_we_end
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id AND c.org_id = ${orgId}
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id AND p.org_id = ${orgId}
    WHERE s.org_id = ${orgId}
      AND s.status <> 'archived'
      AND c.link_mode = 'tracked'
      AND (
        (s.scheduled_at AT TIME ZONE ${tz})::date = (now() AT TIME ZONE ${tz})::date
        OR (s.sent_at AT TIME ZONE ${tz})::date = (now() AT TIME ZONE ${tz})::date
        OR (s.schedule_missed_at AT TIME ZONE ${tz})::date = (now() AT TIME ZONE ${tz})::date
      )
  `)) as unknown as {
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
  }[];

  if (rows.length === 0) {
    return NextResponse.json({ data: [], counts: {} });
  }

  // Materialization counts for exactly these stages (single grouped query).
  const stageIds = rows.map((r) => Number(r.stage_id));
  const countRows = (await db.execute(sql`
    SELECT
      stage_id,
      -- 'rejected' = operator-canceled rows kept for audit (see …/send/abort).
      -- Excluded from total (so "Prepared for today" + sent/total denominators
      -- don't count canceled rows or double-count after re-materialize) and NOT
      -- folded into 'failed' (a cancel is not a delivery failure).
      count(*) FILTER (WHERE status <> 'rejected')::int AS total,
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'sending')::int AS sending,
      count(*) FILTER (WHERE status = 'sent')::int AS sent,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      count(*) FILTER (WHERE status = 'skipped_duplicate')::int AS skipped_duplicate,
      -- STOP-cancels: opted out after materialization, suppressed at dispatch or
      -- by the opt-out ingester. Own bucket — not a delivery failure, not a
      -- manual recall ('rejected'), not a dedup skip.
      count(*) FILTER (WHERE status = 'skipped_opted_out')::int AS skipped_opted_out
    FROM stage_sends
    WHERE org_id = ${orgId} AND ${inArray(stage_sends.stage_id, stageIds)}
    GROUP BY stage_id
  `)) as unknown as {
    stage_id: number;
    total: number;
    pending: number;
    sending: number;
    sent: number;
    failed: number;
    skipped_duplicate: number;
    skipped_opted_out: number;
  }[];
  const countsByStage = new Map(
    countRows.map((r) => [
      Number(r.stage_id),
      {
        total: Number(r.total),
        pending: Number(r.pending),
        sending: Number(r.sending),
        sent: Number(r.sent),
        failed: Number(r.failed),
        skippedDuplicate: Number(r.skipped_duplicate),
        skippedOptedOut: Number(r.skipped_opted_out),
      },
    ]),
  );

  const data = rows.map((r) => {
    const counts = countsByStage.get(Number(r.stage_id)) ?? {
      total: 0,
      pending: 0,
      sending: 0,
      sent: 0,
      failed: 0,
      skippedDuplicate: 0,
      skippedOptedOut: 0,
    };
    const op =
      deriveStageOperationalStatus({
        linkMode: r.link_mode,
        status: r.status,
        scheduledAt: r.scheduled_at,
        sentAt: r.sent_at,
        scheduleMissedAt: r.schedule_missed_at,
        materializedAt: r.materialized_at,
        counts,
      }) ?? "draft";

    // B5 — send-window open/close on the scheduled day (sender ET zone). Only
    // meaningful for stages with a schedule that hasn't sent yet.
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
    };
  });

  // Surface action-needed (Orange/Red) to the top, then lifecycle, then by
  // schedule time within a bucket.
  data.sort((a, b) => {
    const wa = STAGE_STATUS_META[a.operational_status].sortWeight;
    const wb = STAGE_STATUS_META[b.operational_status].sortWeight;
    if (wa !== wb) return wa - wb;
    const ta = a.scheduled_at ? Date.parse(a.scheduled_at) : Infinity;
    const tb = b.scheduled_at ? Date.parse(b.scheduled_at) : Infinity;
    return ta - tb;
  });

  // Tile counts per operational status for the dashboard header.
  const counts: Record<string, number> = {};
  for (const d of data) {
    counts[d.operational_status] = (counts[d.operational_status] ?? 0) + 1;
  }

  return NextResponse.json({ data, counts });
}
