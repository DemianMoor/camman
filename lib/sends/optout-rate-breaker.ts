import type { db } from "@/db/client";
import {
  countOptOutAttributionsSince,
  countSentSinceForCampaign,
  latchCampaignPause,
  optOutRateMinSends,
  optOutRateSpikeThreshold,
  optOutRateWindowSeconds,
} from "@/lib/sends/circuit-breakers";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// P7 — the rolling opt-out-rate breaker check, called by the opt-out ingesters
// right after they record an attribution. Computes the campaign's STOP rate over
// the trailing window and, if it exceeds the threshold AND the campaign has
// cleared the minimum-send floor, latches the PER-CAMPAIGN pause (P8 scope).
//
// The LATCH runs inside the caller's tx (atomic with the attribution). The
// Telegram alert does NOT run here — the caller fires it POST-COMMIT via
// optOutBreakerAlertText(), so a tx rollback can't send a false "paused" alert
// and no HTTP round-trip is held inside the tx. `tripped` is true only on the
// FIRST trip (latchCampaignPause is idempotent), so alerts never repeat.

export interface OptOutRateCheckResult {
  evaluated: boolean; // false ⇒ below the min-send floor (rate not judged)
  sent: number;
  opt_outs: number;
  rate: number; // opt_outs / sent
  threshold: number;
  window_seconds: number;
  tripped: boolean; // THIS call latched the pause (fire the alert)
}

export async function checkOptOutRateBreaker(
  dbc: DbOrTx,
  { orgId, campaignId }: { orgId: string; campaignId: number },
): Promise<OptOutRateCheckResult> {
  const window = optOutRateWindowSeconds();
  const threshold = optOutRateSpikeThreshold();
  const minSends = optOutRateMinSends();

  // Sequential, NOT Promise.all: this always runs inside the ingester's tx, and
  // concurrent execute() on a postgres-js tx connection desyncs its pipeline
  // (same single-query-at-a-time discipline the drain enforces). Two small
  // indexed counts — the serial cost is negligible.
  const sent = await countSentSinceForCampaign(dbc, orgId, campaignId, window);
  const optOuts = await countOptOutAttributionsSince(dbc, orgId, campaignId, window);
  const rate = sent > 0 ? optOuts / sent : 0;
  const base = { sent, opt_outs: optOuts, rate, threshold, window_seconds: window };

  // Floor: never judge a rate on a small sample (1 STOP of 20 = 5% is noise).
  if (sent < minSends) return { ...base, evaluated: false, tripped: false };
  if (rate < threshold) return { ...base, evaluated: true, tripped: false };

  const reason =
    `optout_rate_spike: ${(rate * 100).toFixed(1)}% (${optOuts}/${sent}) over ${Math.round(window / 3600)}h`;
  const tripped = await latchCampaignPause(dbc, { campaignId, orgId, reason });
  return { ...base, evaluated: true, tripped };
}

// Telegram body for a trip. Includes the actual rate + counts + a campaign link,
// per the approved decision. Caller fires it (best-effort) after commit.
export function optOutBreakerAlertText(
  campaignId: number,
  campaignName: string | null,
  r: OptOutRateCheckResult,
): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
  const link = base ? `${base}/campaigns/${campaignId}` : `campaign ${campaignId}`;
  const hours = Math.round(r.window_seconds / 3600);
  return (
    `🛑 Opt-out-rate breaker TRIPPED — campaign send PAUSED\n` +
    `${campaignName ? `"${campaignName}" ` : ""}(id ${campaignId})\n` +
    `${(r.rate * 100).toFixed(1)}% opt-out rate — ${r.opt_outs} STOP / ${r.sent} sent in the last ${hours}h ` +
    `(threshold ${(r.threshold * 100).toFixed(0)}%).\n` +
    `Only THIS campaign is paused; the provider stays live. Resume manually: ${link}`
  );
}
