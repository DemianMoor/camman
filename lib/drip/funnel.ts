import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { campaignTierExpr } from "@/lib/campaign-tier";
import { purchasedClause } from "@/lib/sale-attribution";

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
// ⚠️ "TODAY" IS EVENTS, NOT A COHORT. The today column counts things that
// HAPPENED during the current ET day — a click today may belong to a journey
// routed last week — so it is not nested, and no % is computed against today's
// routed (the UI shows counts only). Reach and conversion are dated by DETECTION
// (offer_reached_detected_at), not by the network's event time, which lags by
// hours and would move yesterday's numbers after the day closed. CONVERTED is
// the exception: it counts SALES (purchase events, not buyers) dated by the
// conversion's occurred_at, so both columns equal the Overview Sales column
// (owner, 2026-10-07). It is therefore not nested — a lead who buys twice
// contributes 2 to converted and 1 to reached_offer. The day is an ET-DAY-AS-TIMESTAMPTZ RANGE, never a functional
// predicate on a timestamp column (same rule as lib/drip/numbers.ts).
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
  /** Journeys that ENTERED this outcome today (closed_at in the ET day).
   *  null for a live state (routed/active) — those are a snapshot, not an event. */
  today_count: number | null;
}

export interface FunnelStageRow {
  stage_id: number;
  stage_number: number | null;
  /** null on the first-send stage; 0..3 on a behavioural lane child (0184). */
  behavioral_tier: number | null;
  label: string;
  sent: number;
  clicks: number;
  opt_outs: number;
}

export interface DripFunnel {
  progression: FunnelProgression;
  /** Events during the current ET day, any journey. NOT nested — see above. */
  today: FunnelProgression;
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

const LIVE_STATES = new Set(["routed", "active"]);

function outcomeLabel(state: string, reason: string | null): string {
  return (
    OUTCOME_LABELS[`${state}|${reason ?? ""}`] ??
    (reason ? `${state} — ${reason.replace(/_/g, " ")}` : state)
  );
}

function laneLabel(tier: number | null, stageNumber: number | null): string {
  if (tier == null) return `Stage ${stageNumber ?? "?"} — first send`;
  return (
    {
      0: "Ignored lane",
      1: "Clicked lane",
      2: "Reached-offer lane",
      3: "Registered lane",
    }[tier] ?? `Tier ${tier} lane`
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
      -- reached_offer deliberately keeps >= 2, so a registrant (tier 3) and a
      -- buyer (tier 4) still count as having reached the offer — that is what a
      -- cumulative high-water funnel means.
      count(*) FILTER (WHERE COALESCE(t.tier, 0) >= 2)::int       AS reached_offer,
      -- converted counts SALES (purchase events), not buyers — owner, 2026-10-07:
      -- a lead who buys twice is two sales, the same number the Overview Sales
      -- column shows. Same purchasedClause, so a $0 registration or a rejected
      -- (refunded) conversion is still not a sale.
      (SELECT count(*)::int FROM conversion_events ce
        WHERE ce.org_id = ${orgId}::uuid AND ce.campaign_id = ${campaignId}
          AND ${purchasedClause()})                                AS converted
    FROM drip_journeys j
    LEFT JOIN (${campaignTierExpr(campaignId, orgId)}) t
           ON t.contact_id = j.contact_id
    WHERE j.org_id = ${orgId}::uuid AND j.campaign_id = ${campaignId}
  `)) as unknown as Record<string, number>[];

  // ── today: events in the current ET day, any journey ─────────────────────
  const { start, end } = campaignDayBoundsUtc();
  const dayStart = sql`${start.toISOString()}::timestamptz`;
  const dayEnd = sql`${end.toISOString()}::timestamptz`;
  const today = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM drip_journeys j
        WHERE j.org_id = ${orgId}::uuid AND j.campaign_id = ${campaignId}
          AND j.routed_at >= ${dayStart} AND j.routed_at < ${dayEnd})             AS routed,
      (SELECT count(*)::int FROM drip_journeys j
        WHERE j.org_id = ${orgId}::uuid AND j.campaign_id = ${campaignId}
          AND j.first_send_at >= ${dayStart} AND j.first_send_at < ${dayEnd})     AS sent,
      -- same clean-click definition as campaignTierExpr's tier-1 branch
      (SELECT count(DISTINCT l.contact_id)::int FROM links l
        JOIN clicks ck ON ck.link_id = l.id
         AND ck.classification NOT IN ('bot','prefetch','suspect')
        WHERE l.org_id = ${orgId}::uuid AND l.campaign_id = ${campaignId}
          AND ck.clicked_at >= ${dayStart} AND ck.clicked_at < ${dayEnd})          AS clicked,
      (SELECT count(DISTINCT ss.contact_id)::int FROM stage_sends ss
        WHERE ss.org_id = ${orgId}::uuid AND ss.campaign_id = ${campaignId}
          AND ss.offer_reached_detected_at >= ${dayStart}
          AND ss.offer_reached_detected_at < ${dayEnd})                     AS reached_offer,
      -- sales, not buyers, dated by occurred_at in the ET day — the same count
      -- and the same day the Overview Sales column uses (stage-day-conversions)
      (SELECT count(*)::int FROM conversion_events ce
        WHERE ce.org_id = ${orgId}::uuid AND ce.campaign_id = ${campaignId}
          AND ${purchasedClause()}
          AND ce.occurred_at >= ${dayStart} AND ce.occurred_at < ${dayEnd})        AS converted
  `)) as unknown as Record<string, number>[];

  // ── outcomes: disjoint, one row per journey ──────────────────────────────
  const outcomes = (await db.execute(sql`
    SELECT j.state, j.close_reason, count(*)::int AS count,
           count(*) FILTER (WHERE j.closed_at >= ${dayStart} AND j.closed_at < ${dayEnd})::int
             AS today_count
    FROM drip_journeys j
    WHERE j.org_id = ${orgId}::uuid AND j.campaign_id = ${campaignId}
    GROUP BY 1, 2
    ORDER BY count(*) DESC
  `)) as unknown as {
    state: string; close_reason: string | null; count: number; today_count: number;
  }[];

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

  const toProgression = (p: Record<string, number> = {}): FunnelProgression => ({
    routed: Number(p.routed ?? 0),
    sent: Number(p.sent ?? 0),
    clicked: Number(p.clicked ?? 0),
    reached_offer: Number(p.reached_offer ?? 0),
    converted: Number(p.converted ?? 0),
  });
  return {
    progression: toProgression(prog[0]),
    today: toProgression(today[0]),
    outcomes: outcomes.map((o) => ({
      state: o.state,
      close_reason: o.close_reason,
      label: outcomeLabel(o.state, o.close_reason),
      count: Number(o.count),
      // routed/active are live: closed_at is NULL by CHECK, so a "today" count
      // would always read 0 and look like news. The UI shows the snapshot.
      today_count: LIVE_STATES.has(o.state) ? null : Number(o.today_count),
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
