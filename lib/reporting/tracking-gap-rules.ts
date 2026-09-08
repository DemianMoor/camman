// Pure predicates for the Keitaro tracking-gap rule.
//
// NO database, drizzle or server-only imports — this module is imported by the
// CLIENT campaign detail page as well as by server routes, crons and the verify
// guards. Keeping it dependency-free is what lets ONE definition serve both
// sides; the same reason lib/stage-url.ts is a pure builder. If you add a query
// helper here, put it in tracking-gap.ts instead.
//
// tracking-gap.ts re-exports everything below, so existing importers are
// unaffected and there is still exactly one definition of each rule.

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

/**
 * Whether Keitaro recorded NO landing-page visits at all for a stage.
 *
 * ⚠️ BOTH COLUMNS, ALWAYS. `visit_clicks_raw` is a superset of
 * `visit_clicks_clean` (no row in the table has clean > raw), so testing clean
 * alone treats "Keitaro saw visits, none of them unique" as a tracking
 * blackout. Measured 2026-08-24 over the Overview's default 7-day range: of 58
 * stages that a clean-only test would flag, 56 had raw > 0 — the marker would
 * have been wrong 96.6% of the time.
 *
 * This is the SHARED definition. The alert (runTrackingGapMonitor — via the
 * SQL CASE in the query below, kept as SQL rather than calling out to this
 * function because it runs inside a single statement, not JS; the two must be
 * edited together) and the display fallback (app/api/keitaro/reports) both key
 * off it, so they cannot disagree about what "no Keitaro visits" means.
 */
export function hasNoKeitaroVisits(visitClicksRaw: number, visitClicksClean: number): boolean {
  return visitClicksRaw === 0 && visitClicksClean === 0;
}

// ── THE DISPLAY SUBSTITUTION RULE ────────────────────────────────────────────
//
// Shared by app/api/keitaro/reports (the Overview tab) and
// scripts/verify-clickers-fallback.ts. The guard used to TRANSCRIBE the two
// conditions route.ts kept inline; a transcribed rule is not a shared rule, and
// the two halves of this feature have already drifted once (PR #129, the
// raw-vs-clean seam). Both call the function below now.

/**
 * Whether enough time has passed since a stage's send for zero Keitaro visits
 * to be EVIDENCE of a tracking gap rather than ordinary latency.
 *
 * ⚠️ THE DISPLAY HALF SHIPPED WITHOUT THIS GATE AND IT WAS THE DEFECT.
 * The alert half has always had TRACKING_GAP_MATURITY_HOURS; the display half
 * deliberately had neither a maturity gate nor a noise floor, on the reasoning
 * that "any real click count is enough to beat showing 0". That reasoning holds
 * only once Keitaro has had a chance to record anything at all.
 *
 * Measured 2026-08-27 against the previous day's mature sends, the Keitaro
 * clean-visit rate is 1–5% of recipients. A late-sequence resend of 9–200
 * contacts is therefore EXPECTED to sit at zero visits for the whole day, while
 * CamMan books a tap within seconds of the send. That morning six campaigns
 * carried the "Keitaro visits unavailable" marker 30–90 minutes after send;
 * FIVE of them had Keitaro visits at campaign level (6–15 clean). The marker
 * was reporting send latency as a broken landing page.
 *
 * A null `sentAt` fails CLOSED (no substitution): maturity is unprovable, and
 * the honest Keitaro zero beats an unverifiable substitute.
 */
export function stageIsMatureForGap(
  sentAt: Date | string | null,
  now: Date,
): boolean {
  if (sentAt == null) return false;
  const t = sentAt instanceof Date ? sentAt.getTime() : Date.parse(sentAt);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t >= TRACKING_GAP_MATURITY_HOURS * 3_600_000;
}

export interface ClickerSubstitutionInput {
  /** campaigns.link_mode — manual campaigns mint no links, so they have no CamMan clicks. */
  linkMode: string;
  visitClicksRaw: number;
  visitClicksClean: number;
  /** CamMan counted clickers for the stage over the SAME range. */
  countedClickers: number;
  /** campaign_stages.sent_at. Null ⇒ not substituted (see stageIsMatureForGap). */
  stageSentAt: Date | string | null;
  now: Date;
}

/**
 * Whether one STAGE's Keitaro visit count should be replaced on screen by
 * CamMan's counted clickers. The whole rule, in one place.
 *
 * Still no noise floor, unlike the alert's TRACKING_GAP_MIN_HUMAN_CLICKS — that
 * threshold exists to avoid paging a human, and a display substitution pages
 * nobody. The maturity gate is what this needed, not a click count.
 */
export function shouldSubstituteClickers(i: ClickerSubstitutionInput): boolean {
  return (
    i.linkMode === "tracked" &&
    hasNoKeitaroVisits(i.visitClicksRaw, i.visitClicksClean) &&
    i.countedClickers > 0 &&
    stageIsMatureForGap(i.stageSentAt, i.now)
  );
}

/**
 * Whether a GROUPED row (a campaign row, or the totals card) should carry the
 * "*" marker and blank the two rates that mix bases.
 *
 * ⚠️ WAS `stages.some(...)` — ONE substituted stage marked the whole row.
 * A campaign with four healthy stages plus one 9-recipient resend lost both
 * CR% and Redirect% while its Keitaro visits were sitting right there in the
 * panel. That is the complaint this rule exists to answer: the marker has to be
 * proportionate to how much of the number is actually a substitute.
 *
 * Majority, not a tuned threshold: below it the row is a Keitaro reading with a
 * patch on it, above it the row is a CamMan reading. At STAGE grain a
 * substituted stage has substituted === total, so this is exactly the previous
 * behaviour there — the change is confined to grouped rows.
 */
export function substitutionDominates(
  substituted: number,
  totalClickers: number,
): boolean {
  return substituted > 0 && substituted * 2 > totalClickers;
}

// The rule, extracted so it is testable without a database.
//
// ⚠️ VISITS ARE THE ONLY KEITARO SIGNAL. Redirects are reported in the alert for
// context but MUST NOT gate it. Requiring redirects = 0 as well (the original
// brief) would skip 3 of the 5 stages that qualify today — campaign 924 (0
// visits, 51 redirects) and both stages of campaign 926 — all of which are the
// same defect. A redirect is fired downstream of the LP and can land even when
// the visit script never runs.
//
// `visits` here is `visits_raw + visits_clean` (see the query below). Summing
// is safe ONLY as a zero-test — neither column is ever negative, so
// `visits === 0` is exactly `hasNoKeitaroVisits(raw, clean)`. Both functions
// express the same "no Keitaro visits" rule; keep them in sync.
export function trackingGapBreached(humanClicks: number, visits: number): boolean {
  return visits === 0 && humanClicks >= TRACKING_GAP_MIN_HUMAN_CLICKS;
}
