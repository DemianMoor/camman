import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { notifyOnTransition } from "@/lib/alerts/alert-state";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { latchCampaignPause } from "@/lib/sends/circuit-breakers";
import { etDay } from "./counters";

// Drip opt-out monitor (Drip Phase 5, ruling G7).
//
// ⭐ WHY DRIP NEEDS ITS OWN MONITOR AT ALL. The existing breaker is per STAGE
// over a rolling window of that stage's recent sends. A drip stage is a DAILY
// RECURRING WINDOW reused by every lead that arrives in it, so a stage-scoped
// rolling window means something quite different there — and below the existing
// breaker's min-sends floor it would not fire at all. This monitor is per
// CAMPAIGN per ET DAY, which is the population an operator actually reasons
// about for a drip campaign.
//
// checkOptOutRateBreaker now skips drip campaigns (R13), so there is exactly one
// owner of a drip campaign's latch: this file.
//
// ⚠️ THE DAY IS AN ET-DAY-AS-TIMESTAMPTZ **RANGE**, never a functional predicate
// on sent_at (R15). `date_trunc('day', sent_at AT TIME ZONE …)` cannot use the
// partial indexes and turns this into a seq scan of a 3.5M-row table. Bounds are
// computed in application code and compared with >= / <.
//
// ⚠️ AND THE RATE IS MEASURED AGAINST THE MESSAGES THAT PRODUCED THE STOPS —
// opt_out_attributions joined through stage_send_id — not against every STOP the
// org received that day. Counting unattributed STOPs would blame a drip campaign
// for opt-outs caused by a blast on the same number.

export const DRIP_OPTOUT_WARN = 0.07;
export const DRIP_OPTOUT_STOP = 0.10;
/** Below this many sends the rate is noise — 1 STOP in 5 sends is not a 20% problem. */
export const DRIP_OPTOUT_MIN_SENDS = 50;

export const DRIP_LATCH_REASON_PREFIX = "drip_optout_rate";

export interface DripOptOutVerdict {
  campaign_id: number;
  campaign_name: string | null;
  sent: number;
  opt_outs: number;
  rate: number;
  level: "ok" | "warn" | "stop";
  latched: boolean;
}

/**
 * Evaluate every active drip campaign for today (ET).
 *
 * Read-mostly: it only writes when a campaign crosses the stop threshold, and
 * `latchCampaignPause` is itself a no-op when the campaign is already paused.
 */
export async function runDripOptOutMonitor(now: Date = new Date()): Promise<DripOptOutVerdict[]> {
  const { start, end } = campaignDayBoundsUtc(now);
  const day = etDay(now);

  const rows = (await db.execute(sql`
    SELECT c.id AS campaign_id, c.org_id, c.name AS campaign_name,
           c.send_paused,
           COALESCE(s.sent, 0)::int AS sent,
           COALESCE(o.opt_outs, 0)::int AS opt_outs
    FROM campaigns c
    LEFT JOIN LATERAL (
      SELECT count(*) AS sent FROM stage_sends ss
      WHERE ss.campaign_id = c.id
        AND ss.status = 'sent'
        AND ss.sent_at >= ${start.toISOString()}::timestamptz
        AND ss.sent_at <  ${end.toISOString()}::timestamptz
    ) s ON true
    LEFT JOIN LATERAL (
      -- Attributed STOPs only: joined through the SEND that produced them, and
      -- bucketed by that send's own sent_at so the numerator and denominator
      -- describe the same population.
      SELECT count(*) AS opt_outs
      FROM opt_out_attributions oa
      JOIN stage_sends ss2 ON ss2.id = oa.stage_send_id
      WHERE oa.campaign_id = c.id
        AND ss2.sent_at >= ${start.toISOString()}::timestamptz
        AND ss2.sent_at <  ${end.toISOString()}::timestamptz
    ) o ON true
    WHERE c.type = 'drip'
      AND c.status = 'active'
  `)) as unknown as {
    campaign_id: number; org_id: string; campaign_name: string | null;
    send_paused: boolean; sent: number; opt_outs: number;
  }[];

  const out: DripOptOutVerdict[] = [];

  for (const r of rows) {
    const sent = Number(r.sent);
    const optOuts = Number(r.opt_outs);
    const rate = sent > 0 ? optOuts / sent : 0;

    // ⚠️ The floor is not a nicety. Without it, the first STOP of the day on a
    // campaign that has sent 3 messages reads as 33% and latches a healthy
    // campaign before it has done anything.
    let level: DripOptOutVerdict["level"] = "ok";
    if (sent >= DRIP_OPTOUT_MIN_SENDS) {
      if (rate >= DRIP_OPTOUT_STOP) level = "stop";
      else if (rate >= DRIP_OPTOUT_WARN) level = "warn";
    }

    let latched = false;
    if (level === "stop" && !r.send_paused) {
      latched = await latchCampaignPause(db, {
        campaignId: r.campaign_id,
        orgId: r.org_id,
        reason:
          `${DRIP_LATCH_REASON_PREFIX}: ${(rate * 100).toFixed(1)}% ` +
          `(${optOuts}/${sent}) on ${day} ET`,
      });
    }

    if (level !== "ok") {
      // Keyed by ET DAY so it re-arms tomorrow instead of latching silent forever.
      await notifyOnTransition(db, {
        alertKey: `drip:optout:${level}:${r.campaign_id}:${day}`,
        orgId: r.org_id,
        text:
          (level === "stop"
            ? `🛑 Drip campaign PAUSED — opt-out rate ${(rate * 100).toFixed(1)}%\n`
            : `⚠️ Drip campaign opt-out rate ${(rate * 100).toFixed(1)}%\n`) +
          `"${r.campaign_name ?? r.campaign_id}" (id ${r.campaign_id}) · ${optOuts} STOP / ${sent} sent ` +
          `on ${day} ET (threshold ${((level === "stop" ? DRIP_OPTOUT_STOP : DRIP_OPTOUT_WARN) * 100).toFixed(0)}%).\n` +
          `Rate is measured against the messages that produced the STOPs, over the ET day.\n` +
          (level === "stop"
            ? `Only THIS campaign is paused; the provider stays live. ` +
              `Accept the risk and resume from the campaign page if this is expected.`
            : `No action taken — this is a warning.`),
      });
    }

    out.push({
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      sent, opt_outs: optOuts, rate, level, latched,
    });
  }

  return out;
}

/**
 * "Accept risk and proceed" — clear a latch THIS monitor set.
 *
 * ⚠️ IT REFUSES TO CLEAR ANY OTHER KIND OF LATCH, and that is the whole safety
 * property. `campaigns.send_paused` is shared: the regular opt-out breaker, the
 * failure-spike breaker and an operator can all set it. An override that cleared
 * it unconditionally would let someone wave away a genuine provider-failure trip
 * from a drip screen, with the button labelled as if it only concerned drip.
 * So the reason string is checked, and a non-drip latch is left exactly as it is.
 */
export async function acceptDripRisk(
  { orgId, campaignId, actorUserId }: {
    orgId: string; campaignId: number; actorUserId: string | null;
  },
): Promise<{ cleared: boolean; reason: string | null; refusedBecause?: string }> {
  const rows = (await db.execute(sql`
    SELECT send_paused, send_paused_reason, type
    FROM campaigns WHERE id = ${campaignId} AND org_id = ${orgId}::uuid LIMIT 1
  `)) as unknown as { send_paused: boolean; send_paused_reason: string | null; type: string }[];
  const c = rows[0];
  if (!c) return { cleared: false, reason: null, refusedBecause: "not_found" };
  if (c.type !== "drip") {
    return { cleared: false, reason: c.send_paused_reason, refusedBecause: "not_a_drip_campaign" };
  }
  if (!c.send_paused) return { cleared: false, reason: null, refusedBecause: "not_paused" };
  if (!c.send_paused_reason?.startsWith(DRIP_LATCH_REASON_PREFIX)) {
    // A provider failure-spike trip, a manual pause, or anything else — not ours.
    return {
      cleared: false,
      reason: c.send_paused_reason,
      refusedBecause: "latch_not_set_by_drip_monitor",
    };
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE campaigns SET send_paused = false, send_paused_reason = NULL, send_paused_at = NULL
      WHERE id = ${campaignId} AND org_id = ${orgId}::uuid
    `);
    await tx.execute(sql`
      INSERT INTO campaign_circuit_events (org_id, campaign_id, event, reason, actor_user_id)
      VALUES (${orgId}::uuid, ${campaignId}, 'resumed',
              ${`drip risk accepted (was: ${c.send_paused_reason})`}, ${actorUserId})
    `);
  });

  return { cleared: true, reason: c.send_paused_reason };
}
