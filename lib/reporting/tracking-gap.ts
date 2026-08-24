import { sql } from "drizzle-orm";

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
  /** Evaluated and NOT breaching — the caller clears these stages' latches. */
  clean_stage_ids: number[];
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
// form says what it means.
export async function runTrackingGapMonitor(dbc: DbOrTx): Promise<TrackingGapReport> {
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
  const clean_stage_ids: number[] = [];

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
      clean_stage_ids.push(Number(r.stage_id));
    }
  }

  return {
    window_days: TRACKING_GAP_WINDOW_DAYS,
    maturity_hours: TRACKING_GAP_MATURITY_HOURS,
    min_human_clicks: TRACKING_GAP_MIN_HUMAN_CLICKS,
    stages_evaluated: rows.length,
    breaches,
    clean_stage_ids,
  };
}
