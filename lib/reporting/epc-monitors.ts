import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// =============================================================================
// EPC INTEGRITY MONITORS
//
// The whole platform's EPC denominator rests on ONE signal: whether a click
// scores `classification = 'human'`, which in turn rests almost entirely on the
// datacenter-ASN check (91% of all taps are excluded by it, nearly all Google
// AS15169 SMS link scanners). If that signal shifts — Google changes ASN, a
// scanner starts arriving from residential-looking IPs, the ASN list goes stale
// — every click metric on the platform moves at once, with no other warning.
//
// The 2026-08-11 incident took two months to notice and was found only because
// someone asked whether buyers were inside the denominator. These three series
// exist so the next one is noticed in days, by the system rather than by luck.
// =============================================================================

export interface EpcMonitorSeries {
  month: string;
  taps: number;
  human: number;
  human_share_pct: number;
}

// MONITOR 1 — human share of taps, monthly.
// The headline canary. A step change means the scorer's verdict distribution
// moved; whether that is real traffic or a scoring regression, it demands a look.
export async function getHumanShareByMonth(
  dbc: DbOrTx,
): Promise<EpcMonitorSeries[]> {
  const rows = (await dbc.execute(sql`
    SELECT to_char(date_trunc('month', clicked_at AT TIME ZONE 'America/New_York'), 'YYYY-MM') AS month,
           count(*)::int AS taps,
           count(*) FILTER (WHERE classification = 'human')::int AS human,
           round(100.0 * count(*) FILTER (WHERE classification = 'human') / nullif(count(*), 0), 3)::float8 AS human_share_pct
    FROM clicks
    GROUP BY 1 ORDER BY 1
  `)) as unknown as EpcMonitorSeries[];
  return rows.map((r) => ({ ...r, human_share_pct: Number(r.human_share_pct) }));
}

// MONITOR 2 — conversion rate of EXCLUDED clickers. Threshold ~0.1%.
//
// This is the one that would have caught the Private Relay bug on day one.
// Bots do not buy. If people the scorer excluded are converting at a
// human-like rate, the scorer is wrong about them — which is exactly what
// relay-ASN traffic was doing at 2.24% against a 0.97% human benchmark.
export const EXCLUDED_CONVERSION_ALERT_PCT = 0.1;

export interface ExcludedConversionResult {
  excluded_clickers: number;
  buyers: number;
  conv_pct: number;
  revenue: number;
  breached: boolean;
}

// Rolling window, matched to the weekly cadence. This monitor reports a RATE,
// not a total, so a 7-day slice detects a scoring regression at least as fast as
// a longer one while keeping the scan small. Widen it freely if a longer trend
// is wanted — the earlier belief that a 90-day window was too slow turned out to
// be a test-harness artifact, not a real limit.
const MONITOR_WINDOW_DAYS = 7;

// Runs inside a transaction with a raised statement_timeout. The DISTINCT over
// clicks joined to links is the heaviest part of the monitor set and the default
// timeout leaves no headroom as history grows. Weekly job, 300s maxDuration.
//
// NOTE for callers: run the monitors on a pool with room for more than one
// connection. This function holds a transaction, so calling it concurrently with
// the other monitors on a max:1 pool deadlocks them behind it.
export async function getExcludedClickerConversion(
  dbc: DbOrTx,
): Promise<ExcludedConversionResult> {
  return await dbc.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '240s'`);
    return await excludedClickerConversionQuery(tx);
  });
}

async function excludedClickerConversionQuery(
  dbc: DbOrTx,
): Promise<ExcludedConversionResult> {
  // Avoids stage_sends entirely, using the Rule F invariant.
  //
  // Honest history, so nobody "restores" the earlier shape: two earlier versions
  // appeared to time out, and I attributed that to query cost. It was not — the
  // verification harness used a max:1 connection pool and ran all four monitors
  // under Promise.all, one of which opens a transaction, so the others queued
  // behind it forever. The earlier query shapes may well have been fine. This
  // shape is kept because it is genuinely simpler and needs no composite index
  // on stage_sends(stage_id, contact_id), not because the others were measured
  // slow.
  //
  // The Rule F invariant makes stage_sends unnecessary: EVERY converted
  // recipient is in counted_clickers, and one with no human click is flagged
  // rescued_by_conversion. So "excluded clickers who bought" is exactly the
  // rescue count, and the excluded population is (everyone who clicked) minus
  // (everyone counted) — both cheap.
  const rows = (await dbc.execute(sql`
    WITH clicked AS (
      SELECT count(DISTINCT (l.stage_id::text || ':' || l.contact_id::text))::int AS n
      FROM clicks cl
      JOIN links l ON l.id = cl.link_id
      WHERE cl.clicked_at >= now() - make_interval(days => ${MONITOR_WINDOW_DAYS})
    ),
    counted AS (
      SELECT count(*) FILTER (WHERE NOT rescued_by_conversion)::int AS counted_n,
             count(*) FILTER (WHERE rescued_by_conversion)::int AS rescued_n
      FROM counted_clickers
      WHERE first_click_at >= now() - make_interval(days => ${MONITOR_WINDOW_DAYS})
    )
    SELECT GREATEST(clicked.n - counted.counted_n, 0)::int AS excluded_clickers,
           counted.rescued_n::int AS buyers,
           round(100.0 * counted.rescued_n
                 / nullif(GREATEST(clicked.n - counted.counted_n, 0), 0), 4)::float8 AS conv_pct
    FROM clicked, counted
  `)) as unknown as { excluded_clickers: number; buyers: number; conv_pct: number }[];
  const r = rows[0];
  const conv = Number(r?.conv_pct ?? 0);
  return {
    excluded_clickers: Number(r?.excluded_clickers ?? 0),
    buyers: Number(r?.buyers ?? 0),
    conv_pct: conv,
    // Revenue is not carried here: it would mean joining stage_sends, which this
    // shape deliberately avoids. The buyer count is the signal that fires the
    // alert; revenue for any breach is one query away.
    revenue: 0,
    breached: conv > EXCLUDED_CONVERSION_ALERT_PCT,
  };
}

// MONITOR 3 — Rule F rescue count. Baseline 8 at build time (2026-08-11).
//
// Rule F counts a converted recipient even when no click of theirs scored human,
// so the revenue numerator can never sit outside the click denominator. That
// makes it a CORRECTION — and a correction that runs silently would mask the
// next scoring regression exactly as the last one was masked. Instrumented so a
// rise is visible: if Rule F starts rescuing materially more than the baseline,
// click scoring is dropping real humans again.
export const RULE_F_BASELINE = 8;
export const RULE_F_ALERT_MULTIPLE = 2.5;

export interface RuleFResult {
  rescues: number;
  baseline: number;
  breached: boolean;
}

export async function getRuleFRescues(dbc: DbOrTx): Promise<RuleFResult> {
  const rows = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM counted_clickers WHERE rescued_by_conversion
  `)) as unknown as { n: number }[];
  const rescues = Number(rows[0]?.n ?? 0);
  return {
    rescues,
    baseline: RULE_F_BASELINE,
    breached: rescues > RULE_F_BASELINE * RULE_F_ALERT_MULTIPLE,
  };
}

// PRECEDENCE ROW-5 PROBE (weekly).
//
// Recon established that Keitaro contributes ZERO clicks: every Keitaro landing
// visit is downstream of a /r/ redirect that already logged a click row, so
// "no CamMan row at all" never fires. The entire decision NOT to build a
// per-click Keitaro ingest rests on that. If it ever stops being true, CamMan is
// dropping clicks — the redirect's click logging is best-effort and swallows
// failures, so this would otherwise be silent.
//
// Cheap proxy, no Keitaro call: count tracked recipients that reached the offer
// (proven by Keitaro via offer_reached_at) yet have NO click row at all. A
// non-zero result means a click happened that CamMan never recorded.
export interface Row5Result {
  reached_without_click: number;
  breached: boolean;
}

export async function getRow5Violations(dbc: DbOrTx): Promise<Row5Result> {
  const rows = (await dbc.execute(sql`
    SELECT count(*)::int AS n
    FROM stage_sends ss
    WHERE ss.offer_reached_at IS NOT NULL
      AND ss.link_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM clicks cl WHERE cl.link_id = ss.link_id)
  `)) as unknown as { n: number }[];
  const n = Number(rows[0]?.n ?? 0);
  return { reached_without_click: n, breached: n > 0 };
}

export interface EpcMonitorReport {
  human_share: EpcMonitorSeries[];
  excluded_conversion: ExcludedConversionResult;
  rule_f: RuleFResult;
  row5: Row5Result;
  breaches: string[];
}

export async function runEpcMonitors(dbc: DbOrTx): Promise<EpcMonitorReport> {
  const [human_share, excluded_conversion, rule_f, row5] = await Promise.all([
    getHumanShareByMonth(dbc),
    getExcludedClickerConversion(dbc),
    getRuleFRescues(dbc),
    getRow5Violations(dbc),
  ]);

  const breaches: string[] = [];
  if (excluded_conversion.breached) {
    breaches.push(
      `Excluded clickers are converting at ${excluded_conversion.conv_pct}% (> ${EXCLUDED_CONVERSION_ALERT_PCT}%): ` +
        `${excluded_conversion.buyers} buyers, $${excluded_conversion.revenue.toFixed(2)}. ` +
        `Bots do not buy — click scoring is likely excluding real people.`,
    );
  }
  if (rule_f.breached) {
    breaches.push(
      `Rule F rescued ${rule_f.rescues} recipients (baseline ${rule_f.baseline}). ` +
        `Rule F is a detector, not just a correction — a rise means click scoring is dropping real humans.`,
    );
  }
  if (row5.breached) {
    breaches.push(
      `${row5.reached_without_click} recipients reached the offer with NO CamMan click row. ` +
        `Precedence row 5 was measured at zero; if it fires, CamMan is losing clicks and the ` +
        `decision to skip the Keitaro per-click ingest needs revisiting.`,
    );
  }
  return { human_share, excluded_conversion, rule_f, row5, breaches };
}
