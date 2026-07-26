// OFFLINE unit tests — no database, no network, no env needed.
//
// Covers the pure halves of the opt-out-rate breaker fix (2026-07-26):
//   • decideOptOutRateBreaker — the two-window trip decision, incl. the
//     2026-07-25 false-trip shape, which must NOT trip on aligned counts.
//   • optOutBreakerReason / optOutBreakerAlertText — the stage + window must
//     appear, so the audit row and the Telegram alert stay meaningful.
//   • deriveStageOperationalStatus — the new `blocked` state and its precedence.
//   • summarizePausedCampaigns — the dashboards' paused-campaign rollup.
//   • shouldAlertUnjoinable / formatUnjoinableAlert — the null-stage_send_id guard.
//
// The SQL-level cohort alignment (numerator bucketed by the originating send's
// sent_at) is exercised by scripts/test-optout-rate-breaker.ts, which needs a
// database. This file is what runs anywhere.
//
// Run: npx tsx scripts/test-optout-breaker-decision.ts

import {
  decideOptOutRateBreaker,
  optOutBreakerAlertText,
  optOutBreakerReason,
  optOutRateWindowLabel,
  type OptOutRateCheckResult,
  type OptOutRateWindowConfig,
} from "@/lib/sends/optout-rate-breaker";
import { summarizePausedCampaigns } from "@/lib/sends/paused-campaigns";
import {
  formatUnjoinableAlert,
  shouldAlertUnjoinable,
} from "@/lib/sends/unjoinable-attributions";
import {
  deriveStageOperationalStatus,
  STAGE_STATUS_META,
  STAGE_STATUS_ORDER,
  type StageSendCounts,
} from "@/lib/stages/stage-status";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${msg}`);
  if (cond) pass++;
  else fail++;
}

// Production defaults, stated explicitly so the tests don't depend on process.env.
const CFG: { long: OptOutRateWindowConfig; short: OptOutRateWindowConfig } = {
  long: { window_seconds: 86400, threshold: 0.1, min_sends: 200 },
  short: { window_seconds: 7200, threshold: 0.08, min_sends: 200 },
};

const counts = (o: Partial<StageSendCounts> = {}): StageSendCounts => ({
  total: 0, pending: 0, sending: 0, sent: 0, failed: 0, skippedDuplicate: 0, ...o,
});

console.log("=== opt-out-rate breaker — offline unit tests ===\n");

// ── 1. THE FALSE-TRIP REGRESSION ─────────────────────────────────────────────
// Campaign 465, 2026-07-25 10:51 ET. 9,669 messages went out 24h06m earlier; its
// STOPs were still arriving. Receipt-time bucketing counted 120 of those STOPs
// against the 322 messages a small lane stage had just sent → 37.3% → latched.
// On the aligned cohort the same instant is 20/322.
console.log("1) the 2026-07-25 false trip does NOT trip on aligned counts:");
{
  const receiptTimeRate = 120 / 322;
  assert(
    receiptTimeRate >= CFG.long.threshold,
    `the receipt-time metric really did breach (${(receiptTimeRate * 100).toFixed(1)}% >= 10%) — fixture is faithful`,
  );
  const d = decideOptOutRateBreaker(
    { long: { sent: 322, opt_outs: 20 }, short: { sent: 322, opt_outs: 20 } },
    CFG,
  );
  assert(d.tripped_by === null, `aligned 20/322 = 6.2% → no trip (got ${d.tripped_by})`);
  assert(d.evaluated === true, "still evaluated (322 sends clears the 200 floor)");
  assert(
    Math.abs(d.rate - 20 / 322) < 1e-9 && d.window_seconds === 86400,
    `reports the long window when nothing trips (rate ${(d.rate * 100).toFixed(2)}%, ${d.window_seconds}s)`,
  );
}

// The other three campaigns from the incident, same shape.
console.log("   the other three incident campaigns, aligned:");
for (const [id, sent, aligned, receipt] of [
  [467, 253, 6, 74],
  [463, 410, 15, 82],
  [464, 254, 5, 38],
] as const) {
  const d = decideOptOutRateBreaker(
    { long: { sent, opt_outs: aligned }, short: { sent, opt_outs: aligned } },
    CFG,
  );
  assert(
    d.tripped_by === null && receipt / sent >= CFG.long.threshold,
    `campaign ${id}: receipt ${((receipt / sent) * 100).toFixed(1)}% would trip, aligned ${((aligned / sent) * 100).toFixed(1)}% does not`,
  );
}

// ── 2. A GENUINELY BAD COHORT STILL TRIPS ────────────────────────────────────
console.log("\n2) a genuinely high aligned cohort still trips (long window):");
{
  // 62 STOPs against the 500 messages that produced them, all older than 2h.
  const d = decideOptOutRateBreaker(
    { long: { sent: 500, opt_outs: 62 }, short: { sent: 0, opt_outs: 0 } },
    CFG,
  );
  assert(d.tripped_by === "24h", `tripped_by="24h" (got ${d.tripped_by})`);
  assert(d.sent === 500 && d.opt_outs === 62, `reports the tripping window's counts (${d.opt_outs}/${d.sent})`);
  assert(d.threshold === 0.1 && d.window_seconds === 86400, "reports the long window's threshold + duration");
}

// ── 3. SHORT-WINDOW TWIN ─────────────────────────────────────────────────────
console.log("\n3) the 2h twin trips on a fresh toxic send while 24h stays quiet:");
{
  // 5,000 sent over the day at 6% (safe), then 400 fresh sends at 10%.
  const d = decideOptOutRateBreaker(
    { long: { sent: 5000, opt_outs: 300 }, short: { sent: 400, opt_outs: 40 } },
    CFG,
  );
  assert(d.tripped_by === "2h", `tripped_by="2h" (got ${d.tripped_by})`);
  assert(d.sent === 400 && d.opt_outs === 40, `reports the SHORT window's counts (${d.opt_outs}/${d.sent})`);
  assert(d.window_seconds === 7200 && d.threshold === 0.08, "reports the short window's threshold + duration");
  assert(300 / 5000 < CFG.long.threshold, "…and the long window genuinely was below its own threshold");
}

console.log("\n4) the 24h window trips while the 2h twin is below its floor:");
{
  const d = decideOptOutRateBreaker(
    { long: { sent: 1000, opt_outs: 110 }, short: { sent: 50, opt_outs: 25 } },
    CFG,
  );
  assert(d.tripped_by === "24h", `tripped_by="24h" — the 50-send short window is unjudgeable (got ${d.tripped_by})`);
  assert(d.sent === 1000 && d.opt_outs === 110, `reports the LONG window's counts (${d.opt_outs}/${d.sent})`);
}

console.log("\n5) when BOTH windows breach, the acute (short) one is reported:");
{
  const d = decideOptOutRateBreaker(
    { long: { sent: 1000, opt_outs: 200 }, short: { sent: 300, opt_outs: 90 } },
    CFG,
  );
  assert(d.tripped_by === "2h" && d.sent === 300, `short wins (got ${d.tripped_by}, sent ${d.sent})`);
}

// ── 6. FLOORS ────────────────────────────────────────────────────────────────
console.log("\n6) min-send floors:");
{
  const d = decideOptOutRateBreaker(
    { long: { sent: 150, opt_outs: 100 }, short: { sent: 150, opt_outs: 100 } },
    CFG,
  );
  assert(d.evaluated === false && d.tripped_by === null, `66% of 150 sends is not judged (evaluated=${d.evaluated})`);
  const zero = decideOptOutRateBreaker(
    { long: { sent: 0, opt_outs: 0 }, short: { sent: 0, opt_outs: 0 } },
    CFG,
  );
  assert(zero.rate === 0 && zero.tripped_by === null, "zero sends → rate 0, no divide-by-zero");
  const exact = decideOptOutRateBreaker(
    { long: { sent: 200, opt_outs: 20 }, short: { sent: 0, opt_outs: 0 } },
    CFG,
  );
  assert(exact.tripped_by === "24h", "rate exactly AT the threshold trips (>=, not >)");
}

// ── 7. REASON STRING + ALERT TEXT ────────────────────────────────────────────
console.log("\n7) the audit reason names the stage and the tripping window:");
{
  const d = decideOptOutRateBreaker(
    { long: { sent: 500, opt_outs: 62 }, short: { sent: 0, opt_outs: 0 } },
    CFG,
  );
  const reason = optOutBreakerReason(1713, d);
  assert(reason.includes("on stage 1713"), `contains the stage id — "${reason}"`);
  assert(reason.includes("over 24h"), "contains the tripping window");
  assert(reason.startsWith("optout_rate_spike: 12.4% (62/500)"), "keeps the rate + counts prefix");

  const short = decideOptOutRateBreaker(
    { long: { sent: 5000, opt_outs: 300 }, short: { sent: 400, opt_outs: 40 } },
    CFG,
  );
  assert(optOutBreakerReason(99, short).includes("over 2h"), "a short-window trip says 2h");

  const result: OptOutRateCheckResult = { ...d, stage_id: 1713, tripped: true };
  const alert = optOutBreakerAlertText(465, "Glyco Balance", result);
  assert(alert.includes("stage 1713"), "the Telegram alert surfaces the stage too");
  assert(alert.includes("last 24h of sends"), "…and describes the window as a send cohort");

  assert(
    optOutRateWindowLabel(86400) === "24h" &&
      optOutRateWindowLabel(7200) === "2h" &&
      optOutRateWindowLabel(2700) === "45m",
    "window labels render from the configured seconds (24h / 2h / 45m)",
  );
}

// ── 8. STAGE STATUS: `blocked` ───────────────────────────────────────────────
console.log("\n8) deriveStageOperationalStatus — the `blocked` state:");
{
  const base = {
    linkMode: "tracked",
    status: "pending",
    scheduledAt: "2026-07-25T19:00:00Z",
    sentAt: null,
    scheduleMissedAt: null,
    materializedAt: "2026-07-25T18:00:00Z",
  };

  assert(
    deriveStageOperationalStatus({ ...base, counts: counts({ total: 9180, pending: 9180 }) }) === "prepared",
    "a materialized, unfired stage is Prepared when the campaign is live",
  );
  assert(
    deriveStageOperationalStatus({
      ...base,
      campaignSendPaused: true,
      counts: counts({ total: 9180, pending: 9180 }),
    }) === "blocked",
    "…and Blocked once the campaign's send circuit is latched (stage 1713's real shape)",
  );
  assert(
    deriveStageOperationalStatus({
      ...base,
      campaignSendPaused: true,
      scheduleMissedAt: "2026-07-25T22:00:00Z",
      counts: counts({ total: 9180, pending: 9180 }),
    }) === "missed_failed",
    "a genuinely missed window outranks the campaign pause",
  );
  assert(
    deriveStageOperationalStatus({
      ...base,
      campaignSendPaused: true,
      slipHoldAt: "2026-07-25T20:00:00Z",
      counts: counts({ total: 100, pending: 100 }),
    }) === "blocked",
    "the campaign pause outranks a lane slip-hold (releasing the hold changes nothing)",
  );
  assert(
    deriveStageOperationalStatus({
      ...base,
      campaignSendPaused: true,
      counts: counts({ total: 5000, sent: 5000 }),
    }) === "sending_sent",
    "a stage that already finished sending is NOT blocked by a later pause",
  );
  assert(
    deriveStageOperationalStatus({
      ...base,
      campaignSendPaused: true,
      materializedAt: null,
      counts: counts(),
    }) === "blocked",
    "a scheduled-but-unprepared stage is blocked too (Phase A won't materialize it)",
  );
  assert(
    deriveStageOperationalStatus({
      ...base,
      campaignSendPaused: true,
      scheduledAt: null,
      materializedAt: null,
      counts: counts(),
    }) === "draft",
    "an unscheduled draft stays Draft — the pause holds nothing",
  );
  assert(
    STAGE_STATUS_ORDER.includes("blocked") && STAGE_STATUS_META.blocked.willSend === "attention",
    "blocked is in the legend order and reads as needing attention",
  );
  assert(
    STAGE_STATUS_META.blocked.sortWeight === 0,
    "blocked sorts to the top of the fleet list",
  );
}

// ── 9. PAUSED-CAMPAIGN ROLLUP ────────────────────────────────────────────────
console.log("\n9) summarizePausedCampaigns:");
{
  const row = (o: Partial<Parameters<typeof summarizePausedCampaigns>[0][number]>) => ({
    campaign_id: 1,
    campaign_name: "A",
    campaign_paused: false,
    campaign_paused_reason: null,
    campaign_paused_at: null,
    operational_status: "prepared",
    counts: { pending: 0 },
    ...o,
  });
  const out = summarizePausedCampaigns([
    row({ campaign_id: 465, campaign_name: "Glyco", campaign_paused: true, campaign_paused_reason: "optout_rate_spike: …", operational_status: "blocked", counts: { pending: 9180 } }),
    row({ campaign_id: 465, campaign_name: "Glyco", campaign_paused: true, operational_status: "blocked", counts: { pending: 4396 } }),
    row({ campaign_id: 465, campaign_name: "Glyco", campaign_paused: true, operational_status: "sending_sent", counts: { pending: 0 } }),
    row({ campaign_id: 463, campaign_name: "Memory", campaign_paused: true, operational_status: "blocked", counts: { pending: 100 } }),
    row({ campaign_id: 7, campaign_name: "Live", campaign_paused: false, operational_status: "prepared", counts: { pending: 5000 } }),
  ]);
  assert(out.length === 2, `only paused campaigns listed (got ${out.length})`);
  assert(out[0].campaign_id === 465 && out[0].held_messages === 13576, `biggest backlog first, held_messages=${out[0].held_messages}`);
  assert(out[0].held_stages === 2, `already-sent stages don't count as held (got ${out[0].held_stages})`);
  assert(out[0].reason === "optout_rate_spike: …", "carries the pause reason through");

  const noneHeld = summarizePausedCampaigns([
    row({ campaign_id: 9, campaign_paused: true, operational_status: "sending_sent" }),
  ]);
  assert(noneHeld.length === 1 && noneHeld[0].held_messages === 0, "a paused campaign with nothing held still lists");
}

// ── 10. UNJOINABLE-ATTRIBUTION GUARD ─────────────────────────────────────────
console.log("\n10) null-stage_send_id guard:");
{
  assert(
    shouldAlertUnjoinable({ nulls: 0, total: 43487, pct: 0, window_hours: 24 }) === false,
    "today's data (0 nulls) is silent",
  );
  assert(
    shouldAlertUnjoinable({ nulls: 1, total: 100, pct: 0.01, window_hours: 24 }) === false,
    "1% is below the 5% alert threshold",
  );
  assert(
    shouldAlertUnjoinable({ nulls: 12, total: 100, pct: 0.12, window_hours: 24 }) === true,
    "12% of 100 alerts",
  );
  assert(
    shouldAlertUnjoinable({ nulls: 1, total: 3, pct: 1 / 3, window_hours: 24 }) === false,
    "33% of a 3-row sample does NOT alert (small-sample floor)",
  );
  const body = formatUnjoinableAlert({ nulls: 12, total: 100, pct: 0.12, window_hours: 24 });
  assert(body.includes("12/100") && body.includes("12.0%") && body.includes("24h"), "alert body states the counts, share and window");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
