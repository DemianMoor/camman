import { sql } from "drizzle-orm";

import { formatCampaignDateTime } from "@/lib/campaign-timezone";
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

export interface TrackingGapBreach {
  stage_id: number;
  org_id: string;
  tracking_id: string | null;
  campaign_name: string;
  /** HUMAN-classified click rows, the figure the alert quotes. */
  human_clicks: number;
  /** redirect_clicks_clean — the "Offer Redirect" figure the UI shows. */
  redirects: number;
  /** ISO string; render through formatCampaignDateTime for display. */
  sent_at: string;
  destination_url: string | null;
}

export interface TrackingGapReport {
  window_days: number;
  maturity_hours: number;
  min_human_clicks: number;
  stages_evaluated: number;
  breaches: TrackingGapBreach[];
  /**
   * Evaluated and NOT breaching — the caller clears these stages' latches.
   * Carries org_id alongside stage_id because clearAlert() must scope the
   * clear to the stage's own org (see notifyOnTransition's orgId above, which
   * every breach already carries).
   */
  clean_stages: { stage_id: number; org_id: string }[];
}

interface GapRow {
  stage_id: number;
  org_id: string;
  tracking_id: string | null;
  campaign_name: string | null;
  sent_at: string;
  visits: number;
  redirects: number;
  human_clicks: number;
  destination_url: string | null;
}

// One statement. Measured 1.59 s against prod (143 candidate stages, 8 days of
// clicks), down from 3.49 s before the clicked_at bound was added.
//
// ⚠️ THE `clicked_at` BOUND IS LOAD-BEARING, not tidiness. Without it the planner
// seq-scans all 1.38 M rows of `clicks` to apply `classification = 'human'`
// (measured: 1,273,284 rows discarded, 1.95 s). Bounded, it uses
// clicks_clicked_at_idx. The bound is WINDOW + 1 day: a click on a stage sent
// within the window cannot predate that send, so a day of slack is strictly more
// than correctness requires.
//
// ⚠️ VISITS ARE TESTED ON BOTH COLUMNS EXPLICITLY, and redirects are REPORTED
// from `redirect_clicks_clean` ALONE. raw ⊇ clean — they overlap — so summing
// them for the reported figure double-counts (152 instead of the correct 51 on
// stage 3029). The sum is only safe as a zero-test, and even there the explicit
// form says what it means. The CASE's both-zero test below IS
// hasNoKeitaroVisits(k.visits_raw, k.visits_clean) — written out in SQL because
// it runs inside this query, not JS. If that function's rule ever changes, this
// CASE must change with it, and vice versa.
// `opts.orgId` scopes the query to a single org. The cron path (bearer auth)
// deliberately omits it — it must watch every org. The human session path
// must pass its own org: without this, a signed-in `viewer` in any org (the
// route only requires `campaigns.view`) would see breach rows, campaign
// names, and landing-page URLs for every other org too. See CLAUDE.md §3.
export async function runTrackingGapMonitor(
  dbc: DbOrTx,
  opts: { orgId?: string } = {},
): Promise<TrackingGapReport> {
  const orgFilter = opts.orgId ? sql`AND cs.org_id = ${opts.orgId}::uuid` : sql``;
  const rows = (await dbc.execute(sql`
    WITH candidates AS (
      SELECT cs.id AS stage_id, cs.org_id, cs.tracking_id, cs.sent_at,
             c.name AS campaign_name
      FROM campaign_stages cs
      JOIN campaigns c ON c.id = cs.campaign_id
      WHERE cs.sent_at IS NOT NULL
        AND cs.sent_at <  now() - make_interval(hours => ${TRACKING_GAP_MATURITY_HOURS})
        AND cs.sent_at >= now() - make_interval(days  => ${TRACKING_GAP_WINDOW_DAYS})
        AND cs.archived_at IS NULL
        AND c.link_mode = 'tracked'
        ${orgFilter}
    ),
    keitaro AS (
      SELECT k.stage_id,
             sum(k.visit_clicks_raw)::int    AS visits_raw,
             sum(k.visit_clicks_clean)::int  AS visits_clean,
             sum(k.redirect_clicks_clean)::int AS redirects
      FROM keitaro_stage_results k
      JOIN candidates ca ON ca.stage_id = k.stage_id
      GROUP BY 1
    ),
    camman AS (
      SELECT l.stage_id, count(*)::int AS human_clicks
      FROM clicks ck
      JOIN links l ON l.id = ck.link_id
      JOIN candidates ca ON ca.stage_id = l.stage_id
      WHERE ck.classification = 'human'
        AND ck.clicked_at >= now() - make_interval(days => ${TRACKING_GAP_WINDOW_DAYS + 1})
      GROUP BY 1
    )
    SELECT ca.stage_id,
           ca.org_id::text AS org_id,
           ca.tracking_id,
           ca.campaign_name,
           ca.sent_at::text AS sent_at,
           (coalesce(k.visits_raw, 0) + coalesce(k.visits_clean, 0)) AS visits,
           coalesce(k.redirects, 0) AS redirects,
           coalesce(cm.human_clicks, 0) AS human_clicks,
           -- both-zero test = hasNoKeitaroVisits(); see the comment above this query.
           CASE WHEN coalesce(k.visits_raw, 0) = 0
                 AND coalesce(k.visits_clean, 0) = 0
                 AND coalesce(cm.human_clicks, 0) >= ${TRACKING_GAP_MIN_HUMAN_CLICKS}
                THEN (SELECT ld.url
                        FROM links l2
                        JOIN link_destinations ld ON ld.id = l2.destination_id
                       WHERE l2.stage_id = ca.stage_id
                       ORDER BY l2.id DESC
                       LIMIT 1)
                ELSE NULL
           END AS destination_url
    FROM candidates ca
    LEFT JOIN keitaro k  ON k.stage_id  = ca.stage_id
    LEFT JOIN camman  cm ON cm.stage_id = ca.stage_id
    ORDER BY coalesce(cm.human_clicks, 0) DESC
  `)) as unknown as GapRow[];

  const breaches: TrackingGapBreach[] = [];
  const clean_stages: { stage_id: number; org_id: string }[] = [];

  for (const r of rows) {
    const humanClicks = Number(r.human_clicks ?? 0);
    const visits = Number(r.visits ?? 0);
    if (trackingGapBreached(humanClicks, visits)) {
      breaches.push({
        stage_id: Number(r.stage_id),
        org_id: r.org_id,
        tracking_id: r.tracking_id,
        campaign_name: r.campaign_name ?? "(unnamed)",
        human_clicks: humanClicks,
        redirects: Number(r.redirects ?? 0),
        sent_at: r.sent_at,
        destination_url: r.destination_url,
      });
    } else {
      clean_stages.push({ stage_id: Number(r.stage_id), org_id: r.org_id });
    }
  }

  return {
    window_days: TRACKING_GAP_WINDOW_DAYS,
    maturity_hours: TRACKING_GAP_MATURITY_HOURS,
    min_human_clicks: TRACKING_GAP_MIN_HUMAN_CLICKS,
    stages_evaluated: rows.length,
    breaches,
    clean_stages,
  };
}

// One latch per stage. Keyed by stage, not by campaign or host, deliberately:
// a second bad landing page must not hide behind the first one's latch.
export function trackingGapAlertKey(stageId: number): string {
  return `tracking_gap:stage:${stageId}`;
}

// ⚠️ PLAIN TEXT. notifyTelegram() sends without parse_mode, so HTML tags would
// render literally in the channel. Do not add markup here.
export function formatTrackingGapAlert(b: TrackingGapBreach): string {
  return [
    "⚠️ Keitaro tracking gap",
    `Stage ${b.tracking_id ?? b.stage_id} — ${b.campaign_name}`,
    `CamMan recorded ${b.human_clicks.toLocaleString()} clicks, but Keitaro shows ` +
      `0 visits and ${b.redirects.toLocaleString()} redirects since send ` +
      `(${formatCampaignDateTime(b.sent_at)}).`,
    `LP: ${b.destination_url ?? "(no destination recorded)"}`,
    "Likely cause: LP is missing the Keitaro visit script, or the LP is dead/404. " +
      "Open the LP and check both.",
  ].join("\n");
}
