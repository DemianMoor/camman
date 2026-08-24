import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { campaignTierExpr } from "@/lib/campaign-tier";

// The journey funnel for one drip campaign (Drip Phase 7, ruling R4).
//
// ⚠️ TWO SHAPES, NOT ONE, because they answer different questions and DO NOT
// ADD UP TO EACH OTHER:
//
//   progression — how deep did each journey get?  routed ≥ sent ≥ clicked ≥
//                 offer ≥ converted. NESTED and CUMULATIVE: every converted
//                 journey is also counted as clicked. Reading these as
//                 disjoint slices would show a funnel that "loses" nobody.
//   outcomes    — how did each journey END? Disjoint by construction: one
//                 journey has exactly one (state, close_reason). These sum to
//                 the routed total, progression does not.
//
// ⚠️ GROUPED ON (state, close_reason), NOT state ALONE. `completed` covers two
// materially different endings — all_stages_sent (the sequence ran out for
// someone who engaged) and unengaged (the Ignored lane fired and nobody was
// listening). Collapsing them to one "completed" bar throws away the single
// number that says whether the campaign is talking to anyone.
//
// ⚠️ THE TIER COMES FROM campaignTierExpr, not a local re-derivation. The lanes,
// the click report and this funnel therefore cannot disagree about what "clicked"
// means — which is the failure mode this project has already paid for twice.

export interface FunnelProgression {
  routed: number;
  sent: number;
  clicked: number;
  reached_offer: number;
  converted: number;
}

export interface FunnelOutcome {
  state: string;
  close_reason: string | null;
  /** Human label for the (state, close_reason) pair. */
  label: string;
  count: number;
}

export interface FunnelStageRow {
  stage_id: number;
  stage_number: number | null;
  /** null on the first-send stage; 0..2 on a behavioural lane child. */
  behavioral_tier: number | null;
  label: string;
  sent: number;
  clicks: number;
  opt_outs: number;
}

export interface DripFunnel {
  progression: FunnelProgression;
  outcomes: FunnelOutcome[];
  stages: FunnelStageRow[];
}

const OUTCOME_LABELS: Record<string, string> = {
  "active|": "Live",
  "routed|": "Routed, not yet sent",
  "opted_out|stop_received": "Opted out",
  "converted|purchased": "Converted",
  "completed|all_stages_sent": "Completed — sequence finished",
  "completed|unengaged": "Completed — unengaged",
  "expired|campaign_ended": "Expired — campaign ended",
  "exited|campaign_archived": "Exited — campaign archived",
};

function outcomeLabel(state: string, reason: string | null): string {
  return (
    OUTCOME_LABELS[`${state}|${reason ?? ""}`] ??
    (reason ? `${state} — ${reason.replace(/_/g, " ")}` : state)
  );
}

function laneLabel(tier: number | null, stageNumber: number | null): string {
  if (tier == null) return `Stage ${stageNumber ?? "?"} — first send`;
  return (
    { 0: "Ignored lane", 1: "Clicked lane", 2: "Reached-offer lane" }[tier] ??
    `Tier ${tier} lane`
  );
}

export async function getDripFunnel(
  orgId: string,
  campaignId: number,
): Promise<DripFunnel> {
  // ── progression ──────────────────────────────────────────────────────────
  const prog = (await db.execute(sql`
    SELECT
      count(*)::int                                              AS routed,
      count(*) FILTER (WHERE j.first_send_at IS NOT NULL)::int    AS sent,
      count(*) FILTER (WHERE COALESCE(t.tier, 0) >= 1)::int       AS clicked,
      count(*) FILTER (WHERE COALESCE(t.tier, 0) >= 2)::int       AS reached_offer,
      count(*) FILTER (WHERE COALESCE(t.tier, 0) >= 3)::int       AS converted
    FROM drip_journeys j
    LEFT JOIN (${campaignTierExpr(campaignId, orgId)}) t
           ON t.contact_id = j.contact_id
    WHERE j.org_id = ${orgId}::uuid AND j.campaign_id = ${campaignId}
  `)) as unknown as Record<string, number>[];

  // ── outcomes: disjoint, one row per journey ──────────────────────────────
  const outcomes = (await db.execute(sql`
    SELECT j.state, j.close_reason, count(*)::int AS count
    FROM drip_journeys j
    WHERE j.org_id = ${orgId}::uuid AND j.campaign_id = ${campaignId}
    GROUP BY 1, 2
    ORDER BY count(*) DESC
  `)) as unknown as { state: string; close_reason: string | null; count: number }[];

  // ── per stage ────────────────────────────────────────────────────────────
  // ⚠️ Counted from stage_sends, NOT from journeys: a stage's sends are the
  // thing that actually happened. Clicks are joined through `links`, whose rows
  // carry the stage — so a click is attributed to the message that carried the
  // link, never to the journey as a whole.
  const stages = (await db.execute(sql`
    SELECT s.id AS stage_id, s.stage_number, s.behavioral_tier,
           count(ss.id) FILTER (WHERE ss.status = 'sent')::int AS sent,
           COALESCE((
             SELECT count(*)::int FROM links l
             JOIN clicks ck ON ck.link_id = l.id
              AND ck.classification NOT IN ('bot','prefetch','suspect')
             WHERE l.stage_id = s.id AND l.org_id = s.org_id
           ), 0) AS clicks,
           COALESCE((
             SELECT count(DISTINCT oa.opt_out_id)::int
             FROM stage_sends ss2
             JOIN opt_out_attributions oa ON oa.stage_send_id = ss2.id
             WHERE ss2.stage_id = s.id AND ss2.org_id = s.org_id
           ), 0) AS opt_outs
    FROM campaign_stages s
    LEFT JOIN stage_sends ss ON ss.stage_id = s.id AND ss.org_id = s.org_id
    WHERE s.org_id = ${orgId}::uuid
      AND s.campaign_id = ${campaignId}
      AND s.archived_at IS NULL
    GROUP BY s.id, s.stage_number, s.behavioral_tier, s.org_id
    -- first-send (NULL tier) first, then the lanes in tier order
    ORDER BY s.behavioral_tier NULLS FIRST, s.stage_number
  `)) as unknown as Record<string, number | null>[];

  const p = prog[0] ?? {};
  return {
    progression: {
      routed: Number(p.routed ?? 0),
      sent: Number(p.sent ?? 0),
      clicked: Number(p.clicked ?? 0),
      reached_offer: Number(p.reached_offer ?? 0),
      converted: Number(p.converted ?? 0),
    },
    outcomes: outcomes.map((o) => ({
      state: o.state,
      close_reason: o.close_reason,
      label: outcomeLabel(o.state, o.close_reason),
      count: Number(o.count),
    })),
    stages: stages.map((s) => ({
      stage_id: Number(s.stage_id),
      stage_number: s.stage_number == null ? null : Number(s.stage_number),
      behavioral_tier: s.behavioral_tier == null ? null : Number(s.behavioral_tier),
      label: laneLabel(
        s.behavioral_tier == null ? null : Number(s.behavioral_tier),
        s.stage_number == null ? null : Number(s.stage_number),
      ),
      sent: Number(s.sent ?? 0),
      clicks: Number(s.clicks ?? 0),
      opt_outs: Number(s.opt_outs ?? 0),
    })),
  };
}
