import { sql } from "drizzle-orm";

import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import type { IngestResult } from "@/lib/conversions/ingest";
import type { KeitaroReportRange } from "@/lib/keitaro/client";
import {
  HEARTBEAT_JOBS,
  checkHeartbeats,
  heartbeatBreaches,
  type DbOrTx,
  type HeartbeatStatus,
} from "@/lib/reporting/cron-heartbeat";

// =============================================================================
// CONVERSION LEDGER MONITOR — Phase 2 of multi-event conversions.
// docs/04-features/conversion-events.md ("Live ingest and alerts").
//
// /api/keitaro/poll ingests the last 7 ET days of Keitaro conversions into
// conversion_events on every */5 tick. Each way that can go wrong pages Telegram
// ONCE: latched on a FIXED alert_state key via notifyOnTransition, and re-armed
// with clearAlert once the condition is gone.
//
//   conversion_events:fetch_failed      failed ticks — the window was refused
//                                       (Keitaro HTTP error, timeout, MALFORMED
//                                       200, TRUNCATED page) or the ingest threw —
//                                       AND no complete ingest for over
//                                       FETCH_FAILED_DEBOUNCE_MINUTES (debounced:
//                                       one transient failure never pages)
//   conversion_events:invalid_rows      Keitaro rows parseKeitaroLedgerRow rejected
//   conversion_events:org_mismatch      existing ledger rows this run resolved to
//                                       ANOTHER org — not written (no debounce:
//                                       a data-integrity signal)
//   conversion_events:unmapped          any ledger row, all-time, with a NULL
//                                       event type or status
//   conversion_events:type_conflicts    any ledger row whose Keitaro type now
//                                       maps to a different event than its locked one
//   heartbeat:conversion-events-ingest  no complete ingest for over an hour
//                                       (checked by /api/cron/tracking-monitors)
//
// NOT alerted: unresolved conversions (no stage, no offers.keitaro_offer_id).
// They include legitimate non-CamMan traffic; the poll response counts them.
// Nor statusOnlyInBatch: a brand-new status-only row has a NULL event type, so
// the table-level unmapped alert already reports it.
//
// Keys are fixed (not per row, not per hour): one standing condition = one page.
// The poll is cross-org, so these alerts are too — alert_state.org_id stays NULL
// (nullable because "some alerts are global rather than per-org").
//
// ⚠️ PLAIN TEXT. notifyTelegram() sends without parse_mode, so markup would
// render literally. No HTML or Markdown in any formatter below.
// =============================================================================

export const CONVERSION_ALERT_KEYS = {
  fetchFailed: "conversion_events:fetch_failed",
  invalidRows: "conversion_events:invalid_rows",
  orgMismatch: "conversion_events:org_mismatch",
  unmapped: "conversion_events:unmapped",
  typeConflicts: "conversion_events:type_conflicts",
} as const;

export const INGEST_HEARTBEAT_ALERT_KEY = "heartbeat:conversion-events-ingest";

const PREFIX = "🟠 Tier-2 conversions:";
const MAX_SAMPLES = 3;
// Telegram caps a message at 4,096 characters, and Keitaro error bodies and
// unparseable-row samples are external text of unbounded length.
const MAX_LINE = 300;

function clip(s: string): string {
  return s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s;
}

export interface UnmappedSample {
  keitaro_event_id: string;
  keitaro_type: string;
  keitaro_offer_id: number | null;
  offer_name: string | null; // the attributed CamMan offer, when there is one
}

export interface ConflictSample {
  keitaro_event_id: string;
  locked_event_key: string | null;
  keitaro_type: string;
  conflicting_event_key: string | null;
  since: string | null; // ISO-8601 UTC; rendered in ET
}

export interface LedgerHealth {
  unmapped_total: number;
  unmapped_last_24h: number;
  unmapped_samples: UnmappedSample[];
  conflict_total: number;
  conflict_samples: ConflictSample[];
}

export type ConversionAlertDecision =
  | { alertKey: string; state: "firing"; text: string }
  | { alertKey: string; state: "ok" };

// What one cron tick's ingest produced: a result (complete, or a refused window
// with ok:false), or a throw caught by the poll route.
export type IngestOutcome =
  | { kind: "result"; result: IngestResult }
  | { kind: "threw"; range: KeitaroReportRange; error: string };

// fetch_failed debounce (controller decision 2026-09-17): a failed tick pages
// only when the last COMPLETE ingest (the conversion-events-ingest heartbeat) is
// older than this, or was never recorded. With */5 ticks a single transient
// Keitaro timeout or throw never pages.
export const FETCH_FAILED_DEBOUNCE_MINUTES = 15;

// A throw and a refused window (ok:false) are the same failure for alerting.
export function ingestFailed(outcome: IngestOutcome): boolean {
  return outcome.kind === "threw" || !outcome.result.ok;
}

function windowLine(range: KeitaroReportRange): string {
  return `Window: ${range.from} → ${range.to} ${range.timezone}`;
}

function formatFetchFailedAlert(outcome: IngestOutcome, lastSuccessAgeMinutes: number | null): string {
  const range = outcome.kind === "threw" ? outcome.range : outcome.result.range;
  const error =
    outcome.kind === "threw" ? `ingest threw: ${outcome.error}` : (outcome.result.error ?? "(no error message)");
  return [
    `${PREFIX} the conversion ledger ingest keeps failing. Nothing from the failed windows was written.`,
    windowLine(range),
    `Error: ${clip(error)}`,
    `Last complete ingest: ${lastSuccessAgeMinutes === null ? "never recorded" : `${Math.round(lastSuccessAgeMinutes)} min ago`}.`,
    "The conversion_events ledger is not updated while this lasts. Repeated timeouts or HTTP errors: Keitaro or the network is down. A malformed response (a 200 that is not JSON with a rows array and a numeric total, e.g. an HTML bot challenge): something other than the Keitaro API answered. A truncated page: 7 days of conversions no longer fit one Keitaro page and the window needs splitting. A thrown error is also in the poll's conversion_events_error and the Vercel logs.",
  ].join("\n");
}

function formatInvalidRowsAlert(ingest: IngestResult): string {
  return [
    `${PREFIX} ${ingest.invalid} Keitaro conversion row(s) could not be parsed and are NOT in the ledger.`,
    windowLine(ingest.range),
    ...ingest.invalidSamples.slice(0, MAX_SAMPLES).map((s) => `- ${clip(s)}`),
    "Compare the samples with KEITARO_LEDGER_COLUMNS (lib/keitaro/client.ts) and parseKeitaroLedgerRow (lib/conversions/keitaro-row.ts).",
  ].join("\n");
}

function formatOrgMismatchAlert(ingest: IngestResult): string {
  return [
    `${PREFIX} ${ingest.orgMismatch} conversion(s) resolved to a different org than their stored ledger row and were NOT written.`,
    windowLine(ingest.range),
    ...ingest.orgMismatchSamples.slice(0, MAX_SAMPLES).map((s) => `- ${clip(s)}`),
    "Samples are event_id stored_org→resolved_org. org_id is fixed at insert, so the stored row keeps its org, attribution and event type. Find which lookup now points into another org (stage tracking id, stage_sends id or offers.keitaro_offer_id) before correcting anything by SQL. See docs/04-features/conversion-events.md.",
  ].join("\n");
}

function offerLabel(s: UnmappedSample): string {
  if (s.offer_name !== null) return s.offer_name;
  return s.keitaro_offer_id !== null ? `Keitaro offer ${s.keitaro_offer_id}` : "no offer";
}

function formatUnmappedAlert(h: LedgerHealth): string {
  return [
    `${PREFIX} ${h.unmapped_total} conversion(s) have no event-type mapping (${h.unmapped_last_24h} new in the last 24h).`,
    "They are stored but never counted as a purchase or as revenue.",
    ...h.unmapped_samples
      .slice(0, MAX_SAMPLES)
      .map((s) => `- ${clip(s.keitaro_event_id)} · ${clip(offerLabel(s))} · type ${clip(s.keitaro_type)}`),
    "Fix: add a conversion_event_mappings row for that network or offer and Keitaro type; rows inside the 7-day live window heal on the next tick. A row first seen through a status-only rule (e.g. rejected) has no event type to heal into and needs one set by SQL. See docs/04-features/conversion-events.md.",
  ].join("\n");
}

function formatTypeConflictsAlert(h: LedgerHealth): string {
  return [
    `${PREFIX} ${h.conflict_total} conversion(s) changed Keitaro type to one that maps to a different event. The locked event type was kept.`,
    ...h.conflict_samples
      .slice(0, MAX_SAMPLES)
      .map(
        (s) =>
          `- ${clip(s.keitaro_event_id)} · locked ${s.locked_event_key ?? "?"} · Keitaro type ${clip(s.keitaro_type)} → ${s.conflicting_event_key ?? "?"} · since ${formatCampaignDateTime(s.since)}`,
      ),
    'Decide which event is right: see "Event-type conflicts" in docs/04-features/conversion-events.md.',
  ].join("\n");
}

export function formatIngestHeartbeatAlert(breach: string): string {
  return [
    `${PREFIX} the ledger ingest has not completed a window recently.`,
    breach,
    "Check the /api/keitaro/poll cron: conversion_events_error in its response, the Vercel logs, and any conversion_events:fetch_failed alert.",
  ].join("\n");
}

// Decisions from ONE cron tick's ingest outcome.
//   complete window → clear fetch_failed; fire or clear invalid_rows; fire or
//     clear org_mismatch (no debounce).
//   failed tick (refused — HTTP error, timeout, malformed, truncated — or threw)
//     → fire fetch_failed only when the last complete ingest is older than
//     FETCH_FAILED_DEBOUNCE_MINUTES or was never recorded; otherwise NO decision
//     (neither fire nor clear). invalid_rows and org_mismatch never get a
//     decision on a failed tick: nothing was parsed or upserted.
// lastSuccessAgeMinutes: minutes since the conversion-events-ingest heartbeat,
// null = never recorded. Only consulted for a failed tick.
export function decideIngestAlerts(
  outcome: IngestOutcome,
  lastSuccessAgeMinutes: number | null,
): ConversionAlertDecision[] {
  if (outcome.kind === "result" && outcome.result.ok) {
    const ingest = outcome.result;
    return [
      { alertKey: CONVERSION_ALERT_KEYS.fetchFailed, state: "ok" },
      ingest.invalid > 0
        ? { alertKey: CONVERSION_ALERT_KEYS.invalidRows, state: "firing", text: formatInvalidRowsAlert(ingest) }
        : { alertKey: CONVERSION_ALERT_KEYS.invalidRows, state: "ok" },
      ingest.orgMismatch > 0
        ? { alertKey: CONVERSION_ALERT_KEYS.orgMismatch, state: "firing", text: formatOrgMismatchAlert(ingest) }
        : { alertKey: CONVERSION_ALERT_KEYS.orgMismatch, state: "ok" },
    ];
  }
  if (lastSuccessAgeMinutes !== null && lastSuccessAgeMinutes <= FETCH_FAILED_DEBOUNCE_MINUTES) {
    return [];
  }
  return [
    {
      alertKey: CONVERSION_ALERT_KEYS.fetchFailed,
      state: "firing",
      text: formatFetchFailedAlert(outcome, lastSuccessAgeMinutes),
    },
  ];
}

// Decisions from the whole-ledger health read (all-time, all orgs).
export function decideLedgerAlerts(h: LedgerHealth): ConversionAlertDecision[] {
  return [
    h.unmapped_total > 0
      ? { alertKey: CONVERSION_ALERT_KEYS.unmapped, state: "firing", text: formatUnmappedAlert(h) }
      : { alertKey: CONVERSION_ALERT_KEYS.unmapped, state: "ok" },
    h.conflict_total > 0
      ? { alertKey: CONVERSION_ALERT_KEYS.typeConflicts, state: "firing", text: formatTypeConflictsAlert(h) }
      : { alertKey: CONVERSION_ALERT_KEYS.typeConflicts, state: "ok" },
  ];
}

// ── DB: ledger health, alert application, ingest heartbeat ──────────────────

type Send = (text: string) => Promise<boolean>;

// Each count's WHERE is written EXACTLY as its partial index's predicate
// (migration 0181), so the planner can answer it from that small index however
// large the ledger grows. Exported so scripts/test-conversion-monitor-db.ts can
// EXPLAIN the very statements this module runs.
export const UNMAPPED_COUNT_SQL = sql`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS last_24h
  FROM conversion_events
  WHERE event_type_id IS NULL OR status IS NULL`;

export const CONFLICT_COUNT_SQL = sql`
  SELECT count(*)::int AS total
  FROM conversion_events
  WHERE conflicting_event_type_id IS NOT NULL`;

// Whole ledger, all orgs (the alerts are global). Four small reads per cron tick.
export async function readLedgerHealth(dbc: DbOrTx): Promise<LedgerHealth> {
  const [unmapped] = (await dbc.execute(UNMAPPED_COUNT_SQL)) as unknown as {
    total: number;
    last_24h: number;
  }[];
  const unmappedSamples = (await dbc.execute(sql`
    SELECT ce.keitaro_event_id, ce.keitaro_type, ce.keitaro_offer_id, o.name AS offer_name
    FROM conversion_events ce
    LEFT JOIN offers o ON o.id = ce.offer_id
    WHERE ce.event_type_id IS NULL OR ce.status IS NULL
    ORDER BY ce.created_at DESC, ce.id DESC
    LIMIT ${MAX_SAMPLES}
  `)) as unknown as UnmappedSample[];
  const [conflicts] = (await dbc.execute(CONFLICT_COUNT_SQL)) as unknown as { total: number }[];
  const conflictSamples = (await dbc.execute(sql`
    SELECT ce.keitaro_event_id,
           lt.key AS locked_event_key,
           ce.keitaro_type,
           mt.key AS conflicting_event_key,
           to_char(ce.event_type_conflict_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS since
    FROM conversion_events ce
    LEFT JOIN event_types lt ON lt.id = ce.event_type_id
    LEFT JOIN event_types mt ON mt.id = ce.conflicting_event_type_id
    WHERE ce.conflicting_event_type_id IS NOT NULL
    ORDER BY ce.event_type_conflict_at DESC NULLS LAST, ce.id DESC
    LIMIT ${MAX_SAMPLES}
  `)) as unknown as ConflictSample[];
  return {
    unmapped_total: Number(unmapped.total),
    unmapped_last_24h: Number(unmapped.last_24h),
    unmapped_samples: unmappedSamples.map((s) => ({
      keitaro_event_id: s.keitaro_event_id,
      keitaro_type: s.keitaro_type,
      keitaro_offer_id: s.keitaro_offer_id === null ? null : Number(s.keitaro_offer_id),
      offer_name: s.offer_name,
    })),
    conflict_total: Number(conflicts.total),
    conflict_samples: conflictSamples.map((s) => ({
      keitaro_event_id: s.keitaro_event_id,
      locked_event_key: s.locked_event_key,
      keitaro_type: s.keitaro_type,
      conflicting_event_key: s.conflicting_event_key,
      since: s.since,
    })),
  };
}

async function applyDecisions(
  dbc: DbOrTx,
  decisions: readonly ConversionAlertDecision[],
  send: Send | undefined,
): Promise<void> {
  for (const d of decisions) {
    // Both helpers are best-effort and never throw; org-less because the
    // ledger alerts are global.
    if (d.state === "firing") {
      await notifyOnTransition(dbc, { alertKey: d.alertKey, text: d.text, send });
    } else {
      await clearAlert(dbc, { alertKey: d.alertKey });
    }
  }
}

// Minutes since the last COMPLETE ingest (the conversion-events-ingest
// heartbeat), or null when none was ever recorded. Read through checkHeartbeats,
// which rounds the age to 0.1h, so the debounce resolves in 6-minute steps: a
// last success under 15 min old reads as ≤ 12, one 15 min or older as ≥ 18.
async function readLastSuccessAgeMinutes(dbc: DbOrTx): Promise<number | null> {
  const [status] = await checkHeartbeats(dbc, [HEARTBEAT_JOBS.conversionEventsIngest]);
  return status.age_hours === null ? null : status.age_hours * 60;
}

// Cron path of /api/keitaro/poll, right after the ingest — including an ingest
// that THREW (the route passes { kind: "threw" }). The heartbeat age is read
// only for a failed tick (the fetch_failed debounce). The ingest decisions are
// applied FIRST, so a failed tick past the debounce still pages even if the
// health read then fails — that failure propagates to the caller, which reports
// it and does not stamp the heartbeat. `send` is injectable only for the DB test.
export async function evaluateConversionAlerts(
  dbc: DbOrTx,
  outcome: IngestOutcome,
  opts: { send?: Send } = {},
): Promise<{ health: LedgerHealth; decisions: ConversionAlertDecision[] }> {
  const lastSuccessAgeMinutes = ingestFailed(outcome) ? await readLastSuccessAgeMinutes(dbc) : null;
  const ingestDecisions = decideIngestAlerts(outcome, lastSuccessAgeMinutes);
  await applyDecisions(dbc, ingestDecisions, opts.send);
  const health = await readLedgerHealth(dbc);
  const ledgerDecisions = decideLedgerAlerts(health);
  await applyDecisions(dbc, ledgerDecisions, opts.send);
  return { health, decisions: [...ingestDecisions, ...ledgerDecisions] };
}

// Dead-man for the ingest, called by /api/cron/tracking-monitors (hourly) — a
// job that is dead cannot report itself dead, so the poll never calls this.
// A NULL watermark (never ran) counts as stale, as everywhere else.
export async function watchIngestHeartbeat(
  dbc: DbOrTx,
  opts: { send?: Send } = {},
): Promise<HeartbeatStatus> {
  const [status] = await checkHeartbeats(dbc, [HEARTBEAT_JOBS.conversionEventsIngest]);
  const [breach] = heartbeatBreaches([status]);
  if (breach !== undefined) {
    await notifyOnTransition(dbc, {
      alertKey: INGEST_HEARTBEAT_ALERT_KEY,
      text: formatIngestHeartbeatAlert(breach),
      send: opts.send,
    });
  } else {
    await clearAlert(dbc, { alertKey: INGEST_HEARTBEAT_ALERT_KEY });
  }
  return status;
}
