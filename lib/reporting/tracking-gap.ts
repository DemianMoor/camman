import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// =============================================================================
// KEITARO TRACKING-GAP MONITOR
//
// CamMan mints a tracked short link per recipient and records every tap in
// `clicks`. Keitaro records a landing-page VISIT only if the LP carries its
// visit script. When that script is missing — or the LP is dead — CamMan keeps
// recording taps while `keitaro_stage_results.visit_clicks_*` stay at zero, and
// NOTHING ELSE NOTICES: sends succeed, DLRs arrive, and the Overview tab renders
// "Clickers 0" as though nobody clicked.
//
// Measured 2026-08-24 over 14 days of tracked stages, split by landing-page host:
//   www.guidekn.com  284 stages  26,933 human clicks  21,860 visits   0 gaps
//   www.lumzen.co      6 stages     881 human clicks       0 visits   5 gaps
//   www.fitsyou.net    1 stage       11 human clicks       0 visits   0 gaps
// The split is total. guidekn carries the script; the two newer hosts do not.
//
// ⚠️ THE POINT OF THIS MONITOR IS THE NEXT HOST, NOT THIS ONE. Today's gap is a
// one-line fix on the LP. What has no other detection layer is the next landing
// page that ships without the script — which is why the guard in
// scripts/verify-tracking-gap.ts must keep working after today's gap closes.
// =============================================================================

// How many CamMan HUMAN clicks a stage needs before zero Keitaro visits counts
// as evidence rather than a quiet stage.
//
// CALIBRATED 2026-08-24 on HUMAN-classified clicks, NOT raw taps. Human clicks
// run ~7.7% of all taps (the datacenter-ASN check excludes the rest — see
// lib/reporting/epc-monitors.ts), so 25 human clicks is roughly a 3.5K-recipient
// send. Over the trailing 7 days, 25 and 100 select the SAME stages, so the
// lower bar costs no noise today while staying sensitive to medium sends: at
// 100, a 10K send producing ~77 human clicks would stay silent.
//
// Applying this floor to TOTAL taps instead would pull in the "Test Text
// Request" stage (152 taps / 21 human) — a test campaign, i.e. exactly the noise
// that gets a monitor muted.
export const TRACKING_GAP_MIN_HUMAN_CLICKS = 25;

// Stages younger than this are excluded. The Keitaro poll runs every 5 minutes,
// so 6h is far past any ingestion lag: zero at 6h is evidence, not latency.
export const TRACKING_GAP_MATURITY_HOURS = 6;

// Bounds the scan and stops long-dead stages re-alerting forever.
export const TRACKING_GAP_WINDOW_DAYS = 7;

// The rule, extracted so it is testable without a database.
//
// ⚠️ VISITS ARE THE ONLY KEITARO SIGNAL. Redirects are reported in the alert for
// context but MUST NOT gate it. Requiring redirects = 0 as well (the original
// brief) would skip 3 of the 5 stages that qualify today — campaign 924 (0
// visits, 51 redirects) and both stages of campaign 926 — all of which are the
// same defect. A redirect is fired downstream of the LP and can land even when
// the visit script never runs.
export function trackingGapBreached(humanClicks: number, visits: number): boolean {
  return visits === 0 && humanClicks >= TRACKING_GAP_MIN_HUMAN_CLICKS;
}
