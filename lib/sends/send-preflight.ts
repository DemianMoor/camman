import { sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";

import type { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { CAMPAIGN_TIMEZONE, CAMPAIGN_TIMEZONE_LABEL } from "@/lib/campaign-timezone";
import {
  computePreflightBreakdown,
  type PreflightBreakdown,
} from "@/lib/sends/preflight-breakdown";
import {
  recomputeDueSplitGroups,
  sweepStuckSplitGroups,
} from "@/lib/stages/split-group";

export type DbOrTx = typeof db;

// P5 — the send-preflight cron. ~15 min before a scheduled stage materializes,
// compute its resolved audience + exclusion breakdown, persist it (for the
// /sends/autopilot view), and post a Telegram DIGEST (one per tick, leading with
// a health summary) plus a STANDALONE alert for any red-condition stage
// (will_send=0, ~100% dedup-predicted, or a structural blocker). `preflight_notified_at`
// is the post-once marker so a stage is never re-notified for the same fire.
export const PREFLIGHT_LEAD_MS = 15 * 60 * 1000;

export interface PreflightRunResult {
  considered: number; // stages entering the 15-min window, not yet notified
  preflighted: number; // breakdowns computed + persisted this tick
  red: number; // of those, how many hit a red condition
  digest_sent: boolean;
  // 0174 — behavioural split groups resolved at T-minus-PREFLIGHT_LEAD_MS.
  split_groups_considered: number;
  split_groups_resolved: number;
  split_groups_failed: number;
  // Groups held mid-materialization long past their last lane's slot. Alert-only
  // (never auto-failed) -- see sweepStuckSplitGroups.
  split_groups_stuck: number;
}

interface DueRow {
  stage_id: number;
  campaign_id: number;
  org_id: string;
  stage_number: number;
  label: string | null;
  campaign_name: string;
  scheduled_at: string;
  behavioral_tier: number | null;
}

function isRed(b: PreflightBreakdown): boolean {
  return b.red.no_audience || b.red.all_dedup_predicted || b.red.has_blocker;
}

function etTime(iso: string): string {
  return `${formatInTimeZone(new Date(iso), CAMPAIGN_TIMEZONE, "HH:mm")} ${CAMPAIGN_TIMEZONE_LABEL}`;
}

function stageLabel(r: DueRow): string {
  const lane = r.behavioral_tier != null ? " (lane)" : "";
  const lbl = r.label ? ` "${r.label}"` : "";
  return `${r.campaign_name} · stage ${r.stage_number}${lbl}${lane}`;
}

function redReason(b: PreflightBreakdown): string {
  if (b.red.has_blocker) return `blocked: ${b.blockers.join(", ")}`;
  if (b.red.no_audience) return "0 recipients (all excluded)";
  if (b.red.all_dedup_predicted)
    return `0 will send — all ${b.materialized_audience.toLocaleString()} messaged within the last hour (dedup)`;
  return "needs attention";
}

function autopilotUrl(): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
  return base ? `${base}/sends/autopilot` : "the Autopilot view (/sends/autopilot)";
}

function formatRedAlert(r: DueRow, b: PreflightBreakdown): string {
  return (
    `🔴 Preflight RED — ${stageLabel(r)}\n` +
    `Fires ${etTime(r.scheduled_at)}. ${redReason(b)}.\n` +
    `Abort or re-date: ${autopilotUrl()}`
  );
}

function formatDigest(items: { r: DueRow; b: PreflightBreakdown }[], redCount: number): string {
  const head =
    `🔭 Preflight — ${items.length} stage${items.length === 1 ? "" : "s"} fire in the next 15 min` +
    (redCount > 0 ? ` · ⚠️ ${redCount} need${redCount === 1 ? "s" : ""} attention` : " · all clear");
  const lines = items.map(({ r, b }) => {
    const icon = isRed(b) ? "🔴" : "✅";
    const dedup =
      b.excluded.dedup_1h_predicted > 0 ? ` · ${b.excluded.dedup_1h_predicted.toLocaleString()} dedup-skip` : "";
    return `${icon} ${stageLabel(r)} — ${b.predicted_sends.toLocaleString()} send${dedup} (${etTime(r.scheduled_at)})`;
  });
  return `${head}\n\n${lines.join("\n")}\n\nAbort/re-date: ${autopilotUrl()}`;
}

export async function runSendPreflight(
  dbc: DbOrTx,
  opts?: { now?: Date; orgId?: string; maxStages?: number },
): Promise<PreflightRunResult> {
  const now = opts?.now ?? new Date();
  const orgId = opts?.orgId;
  const maxStages = opts?.maxStages ?? 100;
  const nowIso = now.toISOString();
  const leadIso = new Date(now.getTime() + PREFLIGHT_LEAD_MS).toISOString();

  // ─── 0174: resolve behavioural split groups entering the window ───────────
  // Runs FIRST so the breakdown computed below already reflects the widened
  // (campaign-level) source set rather than the single-parent fallback. Wrapped
  // because this cron must stay best-effort: a split-group failure must never
  // stop the preflight digest for every other stage in the tick.
  let groupSweep = { considered: 0, resolved: 0, failed: 0 };
  try {
    groupSweep = await recomputeDueSplitGroups(dbc, {
      now,
      leadMs: PREFLIGHT_LEAD_MS,
      orgId,
    });
  } catch {
    // swallow — Phase A's lazy resolve is the backstop
  }

  // Per-group timeout. A group that never leaves 'materializing' holds its
  // siblings' already-written rows unreleased forever, and nothing else would
  // ever say so — this is the only alarm for that silent non-delivery. It is
  // ALERT-ONLY and post-once, and it measures from the LAST lane's due time so a
  // legitimately staggered split (lanes scheduled hours apart) never trips it.
  let stuckSweep = { stuck: 0 };
  try {
    stuckSweep = await sweepStuckSplitGroups(dbc, { now, orgId });
  } catch {
    // best-effort, like every other arm of this cron
  }

  const due = (await dbc.execute(sql`
    SELECT s.id AS stage_id, s.campaign_id AS campaign_id, c.org_id AS org_id,
           s.stage_number AS stage_number, s.label AS label, c.name AS campaign_name,
           s.scheduled_at AS scheduled_at, s.behavioral_tier AS behavioral_tier
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    WHERE c.link_mode = 'tracked'
      AND c.status = 'active'
      AND s.send_approved = true
      AND s.scheduled_at IS NOT NULL
      AND s.scheduled_at > ${nowIso}
      AND s.scheduled_at <= ${leadIso}
      AND s.materialized_at IS NULL
      AND s.sent_at IS NULL
      AND s.schedule_missed_at IS NULL
      AND s.slip_hold_at IS NULL
      AND s.preflight_aborted_at IS NULL
      AND s.preflight_notified_at IS NULL
      AND s.archived_at IS NULL
      ${orgId ? sql`AND c.org_id = ${orgId}` : sql``}
    ORDER BY s.scheduled_at ASC
    LIMIT ${maxStages}
  `)) as unknown as DueRow[];

  const items: { r: DueRow; b: PreflightBreakdown }[] = [];
  for (const r of due) {
    let b: PreflightBreakdown;
    try {
      b = await computePreflightBreakdown(dbc, {
        orgId: r.org_id,
        campaignId: Number(r.campaign_id),
        stageId: Number(r.stage_id),
      });
    } catch {
      continue; // best-effort per stage — one failure never blocks the tick
    }
    // Persist + claim the post-once marker in one write (guard against a racing
    // tick with `preflight_notified_at IS NULL`).
    const claimed = (await dbc.execute(sql`
      UPDATE campaign_stages
      SET preflight_result = ${JSON.stringify(b)}::jsonb,
          preflight_computed_at = ${nowIso}::timestamptz,
          preflight_notified_at = ${nowIso}::timestamptz
      WHERE id = ${r.stage_id} AND preflight_notified_at IS NULL
      RETURNING id
    `)) as unknown as { id: number }[];
    if (claimed.length === 0) continue; // lost the race — another tick handled it
    items.push({ r, b });
    if (isRed(b)) await notifyTelegram(formatRedAlert(r, b));
  }

  const redCount = items.filter((i) => isRed(i.b)).length;
  let digestSent = false;
  if (items.length > 0) {
    await notifyTelegram(formatDigest(items, redCount));
    digestSent = true;
  }

  return {
    considered: due.length,
    preflighted: items.length,
    red: redCount,
    digest_sent: digestSent,
    split_groups_considered: groupSweep.considered,
    split_groups_resolved: groupSweep.resolved,
    split_groups_failed: groupSweep.failed,
    split_groups_stuck: stuckSweep.stuck,
  };
}
