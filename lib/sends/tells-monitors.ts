import { sql } from "drizzle-orm";

import { queryDeliveryByStage } from "@/lib/reporting/delivery";
import type { DbOrTx } from "@/lib/sends/textrequest-dlr";

// Tells monitors (Phase 4) — spec §4.5.
//
// ⚠️ THESE ARE COMPLIANCE INFRASTRUCTURE, NOT OBSERVABILITY POLISH.
//
// With STOP-undelivered self-healing closed as won't-build (§8) and Tells
// offering no reconciliation API and no poll, a broken inbound webhook produces
// NO OTHER SYMPTOM: sends keep succeeding, DLRs keep arriving, dashboards look
// healthy, and STOPs pile up unsuppressed until a carrier complaint surfaces it.
// Nothing else in the system can notice. Phase 5 does not go live without these
// armed AND calibrated.
//
// Breach-only, following the EPC monitor pattern — a periodic all-clear message
// trains people to ignore the channel.

// ---------------------------------------------------------------------------
// Thresholds. PROPOSED HERE, CALIBRATED IN PHASE 5 against observed rates.
// A monitor tuned on guesses is a monitor that gets muted.
// ---------------------------------------------------------------------------

// Inbound silence: how many Tells sends must occur in the window before zero
// inbound events is treated as evidence of breakage rather than a quiet day.
// STOPs arrive at a predictable rate on any real send volume; silence across
// thousands of sends means the intake is broken, not that everyone loves us.
// CALIBRATED 2026-08-13 against the 500-message validation send (stage
// 8_59_081326_1_s1_c250): 2 STOPs / 500 sends = a 0.40% STOP rate. For zero
// STOPs to be <1% likely by chance:  N > ln(0.01) / ln(1 - 0.004) ≈ 1149.
// 1200 clears that with headroom. Was 2000 — a guess that would have waited
// ~1.7× longer than necessary before flagging a broken intake, and on the
// compliance-critical monitor that delay is the cost that matters.
export const INBOUND_SILENCE_MIN_SENDS = 1200;
export const INBOUND_SILENCE_WINDOW_HOURS = 24;

// DLR coverage: fraction of matured sends that have at least one terminal DLR.
// KEPT at 0.90 after calibration. The validation send observed 96.0%
// (480/500), leaving only 6 points of headroom — raising the threshold would
// convert ordinary variance into pages. Revisit with several batches of data.
export const DLR_COVERAGE_MIN_RATIO = 0.9;
// Sends younger than this are excluded, or every freshly-sent message would
// count as uncovered.
//
// CALIBRATED 2026-08-13: terminal-DLR latency on the validation send was p50
// 2s, p99 9s, max 401s (~6.7 min). 10 minutes clears the observed maximum with
// ~50% headroom. Was 30 — safe, but it left a completed batch UNEVALUATED for
// half an hour, a long blind spot on a monitor whose job is to notice a dead
// DLR feed quickly.
export const DLR_MATURITY_MINUTES = 10;
export const DLR_COVERAGE_WINDOW_HOURS = 6;
// Below this many matured sends the ratio is statistical noise — don't alert.
export const DLR_COVERAGE_MIN_SENDS = 50;

// Unprocessed backlog: the sweeper runs every 5 minutes, so anything older than
// three intervals means the sweeper is failing or wedged.
export const BACKLOG_STALE_MINUTES = 15;

// UNDELIVERED TRIPWIRE — the runbook's §2b MPS rule, automated.
//
// Carrier filtering on a young toll-free number shows up as `undelivered`, NOT
// as API errors: the send looks perfectly healthy at the API layer while
// delivery decays. Undelivered-per-batch is therefore the signal, not the send
// success rate.
//
// ⚠️ CALIBRATED TO ONE NUMBER. 8% sits against the 5.8% undelivered baseline
// observed on the tls toll-free number at 5/s (validation send 2026-08-13). It
// is NOT a platform constant and MUST NOT be inherited by another provider —
// txr and ahi have no baseline yet (50 and 1 sends all-time). The delivery
// report is the instrument that will accumulate those baselines; each
// DLR-capable provider then gets its OWN configured threshold. Generalization
// path: ClickUp 869ehwae3. Until a provider has a baseline it gets NO
// threshold, not a default 8% — an uncalibrated monitor is a muted monitor.
export const UNDELIVERED_TRIPWIRE_RATIO = 0.08;
// A batch is a STAGE (verified: no stage spans more than one provider).
export const UNDELIVERED_TRIPWIRE_WINDOW_HOURS = 6;

// ---------------------------------------------------------------------------
// Pure decision helpers — extracted so the rules that decide whether an alert
// fires are unit-testable without a database. These are the rules that get a
// monitor muted when they are wrong.
// ---------------------------------------------------------------------------

// ⚠️ THE COUNTING RULE (§4.5). A SUCCESSFUL message emits TWO callbacks (`sent`,
// then `delivered`); a FAILED one emits ONE (`undelivered`, with no preceding
// `sent`). A monitor that assumes two per message reads EVERY genuine failure
// as a coverage gap and fires constantly — which is how it ends up muted.
export function expectedDlrEvents(deliveredMessages: number, undeliveredMessages: number): number {
  return 2 * deliveredMessages + 1 * undeliveredMessages;
}

// Coverage is measured as MESSAGES WITH ≥1 TERMINAL EVENT over matured sends —
// not raw event counts — which sidesteps the 2-vs-1 asymmetry entirely.
// Returns null below the volume floor: a ratio over a handful of sends is noise,
// and alerting on noise is the other way a monitor gets muted.
export function dlrCoverageBreached(maturedSends: number, coveredSends: number): boolean {
  if (maturedSends < DLR_COVERAGE_MIN_SENDS) return false;
  return coveredSends / maturedSends < DLR_COVERAGE_MIN_RATIO;
}

// Zero inbound is only evidence of breakage once enough sends have gone out to
// make silence implausible. Below the floor, silence is just a quiet day.
export function inboundSilenceBreached(tellsSends: number, inboundEvents: number): boolean {
  return tellsSends >= INBOUND_SILENCE_MIN_SENDS && inboundEvents === 0;
}

// The §2b tripwire, per matured batch. Denominator is SENT — the same
// denominator the delivery report divides by, and the one the runbook's
// RECORDED 5.8% baseline actually used. (The runbook's SQL block divided by
// "messages with any DLR event", giving 5.97% for the same batch; the block was
// corrected to match this rule so the runbook and this check cannot disagree.)
//
// Reuses DLR_COVERAGE_MIN_SENDS as the volume floor: below it the rate is noise,
// and alerting on noise is the other way a monitor gets muted.
export function undeliveredTripwireBreached(
  maturedSends: number,
  undelivered: number,
): boolean {
  if (maturedSends < DLR_COVERAGE_MIN_SENDS) return false;
  return undelivered / maturedSends > UNDELIVERED_TRIPWIRE_RATIO;
}

export interface TellsMonitorReport {
  inbound_silence: {
    window_hours: number;
    tells_sends: number;
    inbound_events: number;
    min_sends_threshold: number;
    breached: boolean;
  };
  dlr_coverage: {
    window_hours: number;
    maturity_minutes: number;
    matured_sends: number;
    sends_with_terminal_dlr: number;
    coverage_ratio: number | null;
    // The counting-rule evidence (§4.5): a SUCCESSFUL message emits 2 events
    // (sent, then delivered); a FAILED one emits 1 (undelivered, no preceding
    // sent). Surfaced so the expected-vs-actual event maths is inspectable.
    delivered_messages: number;
    undelivered_messages: number;
    expected_events: number;
    actual_events: number;
    breached: boolean;
  };
  unprocessed_backlog: {
    stale_minutes: number;
    stale_rows: number;
    oldest_age_minutes: number | null;
    stuck_rows: number;
    breached: boolean;
  };
  // The runbook §2b MPS tripwire, per matured batch (= per stage).
  undelivered_tripwire: {
    window_hours: number;
    maturity_minutes: number;
    threshold_ratio: number;
    min_sends_threshold: number;
    /** Batches evaluated (matured sends in window, at or above the floor). */
    batches_evaluated: number;
    /** Every breaching batch, worst first. */
    breached_batches: UndeliveredBatch[];
    breached: boolean;
    /**
     * Non-null ⇒ this check threw and did NOT run. Isolated so a delivery
     * failure cannot blind the compliance checks; surfaced as its own breach so
     * a persistently broken tripwire is still visible.
     */
    error: string | null;
  };
  // DIAGNOSTIC ONLY — never contributes to breaches (§4.2).
  duplicates: {
    window_hours: number;
    rows_with_duplicates: number;
    total_duplicate_count: number;
  };
  breaches: string[];
}

export interface UndeliveredBatch {
  stage_id: number;
  tracking_id: string | null;
  matured_sends: number;
  undelivered: number;
  undelivered_ratio: number;
}

export async function runTellsMonitors(dbc: DbOrTx): Promise<TellsMonitorReport> {
  const breaches: string[] = [];

  // -------------------------------------------------------------------------
  // 1. INBOUND SILENCE — the compliance-critical one.
  // -------------------------------------------------------------------------
  const silence = (await dbc.execute(sql`
    WITH tells_sends AS (
      SELECT count(*)::int AS n
      FROM stage_sends ss
      JOIN campaign_stages cs ON cs.id = ss.stage_id
      JOIN sms_providers p ON p.id = cs.sms_provider_id
      WHERE p.sms_provider_id = 'tls'
        AND ss.status = 'sent'
        AND ss.sent_at > now() - (${INBOUND_SILENCE_WINDOW_HOURS} * interval '1 hour')
    ),
    inbound AS (
      SELECT count(*)::int AS n
      FROM tells_webhook_events
      WHERE kind = 'inbound'
        AND received_at > now() - (${INBOUND_SILENCE_WINDOW_HOURS} * interval '1 hour')
    )
    SELECT (SELECT n FROM tells_sends) AS sends, (SELECT n FROM inbound) AS inbound_events
  `)) as unknown as { sends: number; inbound_events: number }[];

  const sends = Number(silence[0]?.sends ?? 0);
  const inboundEvents = Number(silence[0]?.inbound_events ?? 0);
  const silenceBreached = inboundSilenceBreached(sends, inboundEvents);
  if (silenceBreached) {
    breaches.push(
      `INBOUND SILENCE (compliance): ${sends} Tells sends in the last ` +
        `${INBOUND_SILENCE_WINDOW_HOURS}h but ZERO inbound events. The STOP intake is ` +
        `almost certainly broken — this is the ONLY automated STOP path for Tells, so ` +
        `opt-outs are going unsuppressed right now. Check the Tells dashboard webhook URL ` +
        `and whether inbound_webhook_token was rotated without updating it.`,
    );
  }

  // -------------------------------------------------------------------------
  // 2. DLR COVERAGE
  //
  // ⚠️ Counts MESSAGES WITH ≥1 TERMINAL EVENT, not raw events. A monitor that
  // assumed two events per message would read EVERY genuine failure as a
  // coverage gap (a failure emits only `undelivered`) and fire constantly —
  // which is how a monitor ends up muted. The expected/actual event figures are
  // reported alongside for the runbook, using 2×delivered + 1×undelivered.
  // -------------------------------------------------------------------------
  const cov = (await dbc.execute(sql`
    WITH matured AS (
      SELECT ss.id
      FROM stage_sends ss
      JOIN campaign_stages cs ON cs.id = ss.stage_id
      JOIN sms_providers p ON p.id = cs.sms_provider_id
      WHERE p.sms_provider_id = 'tls'
        AND ss.status = 'sent'
        AND ss.sent_at > now() - (${DLR_COVERAGE_WINDOW_HOURS} * interval '1 hour')
        AND ss.sent_at < now() - (${DLR_MATURITY_MINUTES} * interval '1 minute')
    ),
    terminal AS (
      SELECT e.matched_stage_send_id AS ss_id,
             bool_or(lower(e.status) = 'delivered')   AS has_delivered,
             bool_or(lower(e.status) = 'undelivered') AS has_undelivered
      FROM tells_webhook_events e
      WHERE e.kind = 'dlr'
        AND e.matched_stage_send_id IS NOT NULL
        AND lower(e.status) IN ('delivered', 'undelivered')
      GROUP BY e.matched_stage_send_id
    ),
    joined AS (
      SELECT m.id, t.has_delivered, t.has_undelivered
      FROM matured m LEFT JOIN terminal t ON t.ss_id = m.id
    )
    SELECT
      (SELECT count(*)::int FROM matured) AS matured_sends,
      count(*) FILTER (WHERE has_delivered OR has_undelivered)::int AS covered,
      count(*) FILTER (WHERE has_delivered)::int   AS delivered_messages,
      count(*) FILTER (WHERE has_undelivered AND NOT COALESCE(has_delivered, false))::int AS undelivered_messages,
      (SELECT count(*)::int FROM tells_webhook_events e2
        WHERE e2.kind = 'dlr'
          AND e2.matched_stage_send_id IN (SELECT id FROM matured)) AS actual_events
    FROM joined
  `)) as unknown as {
    matured_sends: number; covered: number;
    delivered_messages: number; undelivered_messages: number; actual_events: number;
  }[];

  const maturedSends = Number(cov[0]?.matured_sends ?? 0);
  const covered = Number(cov[0]?.covered ?? 0);
  const deliveredMsgs = Number(cov[0]?.delivered_messages ?? 0);
  const undeliveredMsgs = Number(cov[0]?.undelivered_messages ?? 0);
  const actualEvents = Number(cov[0]?.actual_events ?? 0);
  // THE COUNTING RULE: 2 per success (sent + delivered), 1 per failure.
  const expectedEvents = expectedDlrEvents(deliveredMsgs, undeliveredMsgs);
  const coverageRatio = maturedSends > 0 ? covered / maturedSends : null;
  const covBreached = dlrCoverageBreached(maturedSends, covered);
  if (covBreached) {
    breaches.push(
      `DLR COVERAGE: only ${covered}/${maturedSends} matured Tells sends ` +
        `(${(coverageRatio! * 100).toFixed(1)}%) have a terminal delivery receipt, below the ` +
        `${(DLR_COVERAGE_MIN_RATIO * 100).toFixed(0)}% threshold. Either the DLR webhook is ` +
        `failing or Tells stopped calling it. NOTE: Tells abandons a message's remaining ` +
        `statuses after 4 failed callback attempts, so a DLR outage is not self-healing.`,
    );
  }

  // -------------------------------------------------------------------------
  // 3. UNPROCESSED BACKLOG — is the sweeper actually draining?
  // -------------------------------------------------------------------------
  const backlog = (await dbc.execute(sql`
    SELECT
      count(*) FILTER (
        WHERE processed_at IS NULL
          AND received_at < now() - (${BACKLOG_STALE_MINUTES} * interval '1 minute')
      )::int AS stale_rows,
      count(*) FILTER (WHERE processed_at IS NULL AND process_attempts >= 10)::int AS stuck_rows,
      EXTRACT(EPOCH FROM (now() - min(received_at) FILTER (WHERE processed_at IS NULL))) / 60 AS oldest_age_minutes
    FROM tells_webhook_events
  `)) as unknown as {
    stale_rows: number; stuck_rows: number; oldest_age_minutes: string | number | null;
  }[];

  const staleRows = Number(backlog[0]?.stale_rows ?? 0);
  const stuckRows = Number(backlog[0]?.stuck_rows ?? 0);
  const oldestAge =
    backlog[0]?.oldest_age_minutes == null ? null : Math.round(Number(backlog[0].oldest_age_minutes));
  const backlogBreached = staleRows > 0;
  if (backlogBreached) {
    breaches.push(
      `SWEEPER BACKLOG: ${staleRows} Tells webhook event(s) unprocessed for more than ` +
        `${BACKLOG_STALE_MINUTES} minutes (oldest ${oldestAge ?? "?"} min)` +
        (stuckRows > 0 ? `, of which ${stuckRows} are STUCK at ≥10 failed attempts` : "") +
        `. If any are inbound, those STOPs are not yet suppressed.`,
    );
  }

  // -------------------------------------------------------------------------
  // 4. UNDELIVERED TRIPWIRE (runbook §2b) — carrier filtering on a young
  // toll-free number surfaces as `undelivered`, never as an API error.
  //
  // Computed through lib/reporting/delivery.ts — the SAME layer /reports/delivery
  // reads — so this alert and that page can never disagree. That shared layer is
  // the point; do not reimplement the counting here.
  //
  // DETECT ONLY. The response (drop MPS to 10/s, hold 48h) stays MANUAL per the
  // runbook — nothing here touches provider_phones.max_sends_per_second.
  // -------------------------------------------------------------------------
  const stageRows = (await dbc.execute(sql`
    SELECT cs.id AS stage_id, cs.org_id, cs.tracking_id
    FROM campaign_stages cs
    JOIN sms_providers p ON p.id = cs.sms_provider_id
    WHERE p.sms_provider_id = 'tls'
      AND cs.archived_at IS NULL
      AND cs.sent_at > now() - (${UNDELIVERED_TRIPWIRE_WINDOW_HOURS} * interval '1 hour')
  `)) as unknown as { stage_id: number; org_id: string; tracking_id: string | null }[];

  const trackingById = new Map(
    stageRows.map((r) => [Number(r.stage_id), r.tracking_id ?? null]),
  );
  // Group by org so the shared query keeps its org_id filter (multi-tenancy is
  // application-level first; the provider join alone is not the guard).
  const stagesByOrg = new Map<string, number[]>();
  for (const r of stageRows) {
    const list = stagesByOrg.get(r.org_id) ?? [];
    list.push(Number(r.stage_id));
    stagesByOrg.set(r.org_id, list);
  }

  const now = new Date();
  const batches: UndeliveredBatch[] = [];
  let batchesEvaluated = 0;
  let tripwireError: string | null = null;
  // ⚠️ ISOLATED ON PURPOSE. This is the LEAST critical of the four checks, but
  // it runs the heaviest query — and an uncaught throw here would take down the
  // WHOLE job, including check #1 (inbound silence), which is the sole detection
  // layer for broken STOP intake. A delivery-reporting failure must never blind
  // the compliance monitor. The failure is surfaced as its own breach rather
  // than swallowed, so a persistently broken tripwire is still visible.
  try {
    for (const [orgId, stageIds] of stagesByOrg) {
      const rows = await queryDeliveryByStage(dbc, orgId, {
        fromUtc: new Date(now.getTime() - UNDELIVERED_TRIPWIRE_WINDOW_HOURS * 3_600_000),
        toExclusiveUtc: now,
        // Without maturity every freshly-sent message counts as pending and the
        // ratio is meaningless. Reuses the DLR-latency calibration (p99 9s, max 401s).
        maturedBefore: new Date(now.getTime() - DLR_MATURITY_MINUTES * 60_000),
        stageIds,
      });
      for (const r of rows) {
        if (r.sent < DLR_COVERAGE_MIN_SENDS) continue;
        batchesEvaluated++;
        if (!undeliveredTripwireBreached(r.sent, r.undelivered)) continue;
        batches.push({
          stage_id: r.stage_id,
          tracking_id: trackingById.get(r.stage_id) ?? null,
          matured_sends: r.sent,
          undelivered: r.undelivered,
          undelivered_ratio: Number((r.undelivered / r.sent).toFixed(4)),
        });
      }
    }
  } catch (err) {
    tripwireError = err instanceof Error ? err.message : String(err);
    console.error("[tells-monitors] undelivered tripwire failed", err);
    breaches.push(
      `UNDELIVERED TRIPWIRE FAILED TO EVALUATE: ${tripwireError}. The §2b carrier-filtering ` +
        `check did not run this tick — undelivered rate is UNWATCHED until this is fixed. ` +
        `The STOP-intake and DLR-coverage checks above were unaffected.`,
    );
  }
  batches.sort((a, b) => b.undelivered_ratio - a.undelivered_ratio);
  const tripwireBreached = batches.length > 0;
  if (tripwireBreached) {
    const worst = batches[0];
    breaches.push(
      `UNDELIVERED TRIPWIRE: ${batches.length} matured Tells batch(es) above ` +
        `${(UNDELIVERED_TRIPWIRE_RATIO * 100).toFixed(0)}% undelivered — worst is stage ` +
        `${worst.tracking_id ?? worst.stage_id} at ${(worst.undelivered_ratio * 100).toFixed(1)}% ` +
        `(${worst.undelivered}/${worst.matured_sends}). Baseline for this number is 5.8% at 5/s. ` +
        `Carrier filtering shows up HERE, not as API errors, so the send will look healthy ` +
        `at the API layer. RUNBOOK §2b: drop max_sends_per_second to 10 and hold 48h — ` +
        `announce the change before applying it.`,
    );
  }

  // -------------------------------------------------------------------------
  // 5. DUPLICATES — DIAGNOSTIC ONLY. NEVER ALERTS (§4.2).
  //
  // A duplicate means either Tells retried (we returned a non-2xx) or we
  // replayed deliberately. Both are worth knowing; neither is an incident.
  // Deliberately NOT pushed onto `breaches`.
  // -------------------------------------------------------------------------
  const dup = (await dbc.execute(sql`
    SELECT count(*) FILTER (WHERE duplicate_count > 0)::int AS rows_with_duplicates,
           COALESCE(sum(duplicate_count), 0)::int AS total_duplicate_count
    FROM tells_webhook_events
    WHERE received_at > now() - (${INBOUND_SILENCE_WINDOW_HOURS} * interval '1 hour')
  `)) as unknown as { rows_with_duplicates: number; total_duplicate_count: number }[];

  return {
    inbound_silence: {
      window_hours: INBOUND_SILENCE_WINDOW_HOURS,
      tells_sends: sends,
      inbound_events: inboundEvents,
      min_sends_threshold: INBOUND_SILENCE_MIN_SENDS,
      breached: silenceBreached,
    },
    dlr_coverage: {
      window_hours: DLR_COVERAGE_WINDOW_HOURS,
      maturity_minutes: DLR_MATURITY_MINUTES,
      matured_sends: maturedSends,
      sends_with_terminal_dlr: covered,
      coverage_ratio: coverageRatio === null ? null : Number(coverageRatio.toFixed(4)),
      delivered_messages: deliveredMsgs,
      undelivered_messages: undeliveredMsgs,
      expected_events: expectedEvents,
      actual_events: actualEvents,
      breached: covBreached,
    },
    unprocessed_backlog: {
      stale_minutes: BACKLOG_STALE_MINUTES,
      stale_rows: staleRows,
      oldest_age_minutes: oldestAge,
      stuck_rows: stuckRows,
      breached: backlogBreached,
    },
    undelivered_tripwire: {
      window_hours: UNDELIVERED_TRIPWIRE_WINDOW_HOURS,
      maturity_minutes: DLR_MATURITY_MINUTES,
      threshold_ratio: UNDELIVERED_TRIPWIRE_RATIO,
      min_sends_threshold: DLR_COVERAGE_MIN_SENDS,
      batches_evaluated: batchesEvaluated,
      breached_batches: batches,
      breached: tripwireBreached,
      error: tripwireError,
    },
    duplicates: {
      window_hours: INBOUND_SILENCE_WINDOW_HOURS,
      rows_with_duplicates: Number(dup[0]?.rows_with_duplicates ?? 0),
      total_duplicate_count: Number(dup[0]?.total_duplicate_count ?? 0),
    },
    breaches,
  };
}
