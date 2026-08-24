import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import {
  countAlignedOptOutsInWindowsForStage,
  countSentInWindowsForStage,
  latchCampaignPause,
  optOutRateMinSends,
  optOutRateMinSendsShort,
  optOutRateShortWindowSeconds,
  optOutRateSpikeThreshold,
  optOutRateSpikeThresholdShort,
  optOutRateWindowSeconds,
} from "@/lib/sends/circuit-breakers";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// P7 — the rolling opt-out-rate breaker check, called by the opt-out ingesters
// right after they record an attribution.
//
// SCOPE: the rate is judged on the ATTRIBUTED STAGE, the latch is applied to the
// CAMPAIGN. A campaign mixes a big blast with small behavioural lanes, so a
// campaign-level average is dominated by whichever stage is loudest — the very
// asymmetry that made the 2026-07-25 false trips look plausible. Per-stage is the
// homogeneous cohort; the pause is still per-campaign because that is the unit an
// operator can act on.
//
// Only the attributed stage is evaluated — never a fan-out over the campaign's
// stages. A STOP credits exactly one stage, so no other stage's numerator moved;
// their denominators only ever GROW (new sends), which lowers a rate and cannot
// trip one.
//
// COHORT: numerator and denominator both bucket by stage_sends.sent_at (see
// circuit-breakers.ts). "Of what this stage sent in the window, what fraction has
// STOPped so far."
//
// The LATCH runs inside the caller's tx (atomic with the attribution). The
// Telegram alert does NOT run here — the caller fires it POST-COMMIT via
// optOutBreakerAlertText(), so a tx rollback can't send a false "paused" alert
// and no HTTP round-trip is held inside the tx. `tripped` is true only on the
// FIRST trip (latchCampaignPause is idempotent), so alerts never repeat.

/**
 * Which window breached. The keys are stable identifiers for the LONG and SHORT
 * windows, named after their defaults; the actual durations are env-tunable, so
 * always render `window_seconds` rather than the key when showing a duration.
 */
export type OptOutRateWindowKey = "24h" | "2h";

export interface OptOutRateWindowConfig {
  window_seconds: number;
  threshold: number;
  min_sends: number;
}

export interface OptOutRateWindowCounts {
  sent: number;
  opt_outs: number;
}

export interface OptOutRateDecision {
  /** false ⇒ NEITHER window cleared its min-send floor (rate not judged). */
  evaluated: boolean;
  /** The breaching window, or null when nothing breached. */
  tripped_by: OptOutRateWindowKey | null;
  // The breaching window's figures; the long window's when nothing breached.
  sent: number;
  opt_outs: number;
  rate: number;
  threshold: number;
  window_seconds: number;
}

export interface OptOutRateCheckResult extends OptOutRateDecision {
  /** The stage the rate was judged on. */
  stage_id: number;
  /** THIS call latched the pause (fire the alert). */
  tripped: boolean;
}

/** Both windows' tunables, read fresh from the env on every call. */
export function optOutRateWindowConfigs(): {
  long: OptOutRateWindowConfig;
  short: OptOutRateWindowConfig;
} {
  return {
    long: {
      window_seconds: optOutRateWindowSeconds(),
      threshold: optOutRateSpikeThreshold(),
      min_sends: optOutRateMinSends(),
    },
    short: {
      window_seconds: optOutRateShortWindowSeconds(),
      threshold: optOutRateSpikeThresholdShort(),
      min_sends: optOutRateMinSendsShort(),
    },
  };
}

function rateOf(c: OptOutRateWindowCounts): number {
  return c.sent > 0 ? c.opt_outs / c.sent : 0;
}

/**
 * PURE decision: given both windows' counts, which (if either) breached.
 *
 * A window is judged only once it clears its own min-send floor (never judge a
 * rate on a small sample), and breaches at `rate >= threshold`. When BOTH
 * breach, the SHORT window wins the report: it is the strict subset, so it names
 * the acute, most-recent cohort — the more actionable description for an
 * operator. When neither breaches the long window's figures are reported, since
 * it is the primary judgement.
 */
export function decideOptOutRateBreaker(
  counts: { long: OptOutRateWindowCounts; short: OptOutRateWindowCounts },
  cfg: { long: OptOutRateWindowConfig; short: OptOutRateWindowConfig } = optOutRateWindowConfigs(),
): OptOutRateDecision {
  const longEvaluated = counts.long.sent >= cfg.long.min_sends;
  const shortEvaluated = counts.short.sent >= cfg.short.min_sends;
  const longBreached = longEvaluated && rateOf(counts.long) >= cfg.long.threshold;
  const shortBreached = shortEvaluated && rateOf(counts.short) >= cfg.short.threshold;

  const tripped_by: OptOutRateWindowKey | null = shortBreached
    ? "2h"
    : longBreached
      ? "24h"
      : null;
  const picked = tripped_by === "2h" ? { c: counts.short, k: cfg.short } : { c: counts.long, k: cfg.long };

  return {
    evaluated: longEvaluated || shortEvaluated,
    tripped_by,
    sent: picked.c.sent,
    opt_outs: picked.c.opt_outs,
    rate: rateOf(picked.c),
    threshold: picked.k.threshold,
    window_seconds: picked.k.window_seconds,
  };
}

/** "24h" / "2h" / "45m" — the window duration, from the configured seconds. */
export function optOutRateWindowLabel(seconds: number): string {
  return seconds % 3600 === 0 ? `${seconds / 3600}h` : `${Math.round(seconds / 60)}m`;
}

/**
 * The `campaigns.send_paused_reason` / `campaign_circuit_events.reason` string.
 * Names the STAGE and the breaching WINDOW so the audit row stays meaningful
 * once the numbers have moved on — e.g.
 * `optout_rate_spike: 12.4% (62/500) on stage 1713 over 24h`.
 */
export function optOutBreakerReason(stageId: number, d: OptOutRateDecision): string {
  return (
    `optout_rate_spike: ${(d.rate * 100).toFixed(1)}% (${d.opt_outs}/${d.sent}) ` +
    `on stage ${stageId} over ${optOutRateWindowLabel(d.window_seconds)}`
  );
}

export async function checkOptOutRateBreaker(
  dbc: DbOrTx,
  { orgId, campaignId, stageId }: { orgId: string; campaignId: number; stageId: number },
): Promise<OptOutRateCheckResult> {
  const cfg = optOutRateWindowConfigs();

  // Sequential, NOT Promise.all: this always runs inside the ingester's tx, and
  // concurrent execute() on a postgres-js tx connection desyncs its pipeline
  // (same single-query-at-a-time discipline the drain enforces). Two small
  // per-stage indexed counts — the serial cost is negligible. Both windows come
  // out of each query via FILTER, so this stays at 2 queries per STOP, not 4.
  const sent = await countSentInWindowsForStage(
    dbc, orgId, stageId, cfg.long.window_seconds, cfg.short.window_seconds,
  );
  const optOuts = await countAlignedOptOutsInWindowsForStage(
    dbc, orgId, stageId, cfg.long.window_seconds, cfg.short.window_seconds,
  );

  const decision = decideOptOutRateBreaker(
    {
      long: { sent: sent.long, opt_outs: optOuts.long },
      short: { sent: sent.short, opt_outs: optOuts.short },
    },
    cfg,
  );

  if (decision.tripped_by === null) {
    return { ...decision, stage_id: stageId, tripped: false };
  }

  // ⚠️⚠️ R13 — TYPE AWARENESS, AND THE DIRECTION IS NORMATIVE.
  //
  // A DRIP campaign is governed by its own per-campaign, per-ET-day opt-out
  // monitor (Phase 5), which owns the drip latch. This stage-level breaker
  // therefore does not latch a drip campaign — its stage windows are daily
  // recurring, so a stage-scoped rolling window means something different there.
  //
  // ONLY A POSITIVE, SUCCESSFUL READ OF type = 'drip' MAY SKIP THE LATCH.
  // NULL, an unknown value, a missing row, or a query that throws ⇒ the campaign
  // is treated as REGULAR and the breaker latches exactly as it does today.
  // This function has four live callers, all opt-out ingesters, all
  // compliance-critical: a mistake here silently removes opt-out protection from
  // real campaigns. Fail toward the EXISTING behaviour, never toward the new one.
  let isDrip = false;
  try {
    const typeRows = (await dbc.execute(sql`
      SELECT type FROM campaigns WHERE id = ${campaignId} AND org_id = ${orgId} LIMIT 1
    `)) as unknown as { type: string | null }[];
    isDrip = typeRows[0]?.type === "drip";
  } catch (err) {
    // Unreadable ⇒ regular. Logged, never swallowed silently.
    console.error(
      `[optout-breaker] campaign type unreadable for ${campaignId}; treating as REGULAR ` +
        `and latching as usual:`,
      err,
    );
    isDrip = false;
  }

  if (isDrip) {
    console.warn(
      `[optout-breaker] campaign ${campaignId} is DRIP — stage-level latch skipped; ` +
        `the drip opt-out monitor owns this campaign's latch.`,
    );
    return { ...decision, stage_id: stageId, tripped: false };
  }

  const tripped = await latchCampaignPause(dbc, {
    campaignId,
    orgId,
    reason: optOutBreakerReason(stageId, decision),
  });
  return { ...decision, stage_id: stageId, tripped };
}

// Telegram body for a trip. Includes the actual rate + counts + the stage + a
// campaign link. Caller fires it (best-effort) after commit.
export function optOutBreakerAlertText(
  campaignId: number,
  campaignName: string | null,
  r: OptOutRateCheckResult,
): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
  const link = base ? `${base}/campaigns/${campaignId}` : `campaign ${campaignId}`;
  const label = optOutRateWindowLabel(r.window_seconds);
  return (
    `🛑 Opt-out-rate breaker TRIPPED — campaign send PAUSED\n` +
    `${campaignName ? `"${campaignName}" ` : ""}(id ${campaignId}) · stage ${r.stage_id}\n` +
    `${(r.rate * 100).toFixed(1)}% opt-out rate — ${r.opt_outs} STOP / ${r.sent} sent ` +
    `in that stage's last ${label} of sends (threshold ${(r.threshold * 100).toFixed(0)}%).\n` +
    `Rate is measured against the messages that produced the STOPs, not against whatever was in flight.\n` +
    `Only THIS campaign is paused; the provider stays live. Resume manually: ${link}`
  );
}
