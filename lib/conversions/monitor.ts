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
// ONCE, latched in alert_state via notifyOnTransition, and re-armed with
// clearAlert once the condition is gone.
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
//   conversion_events:unmapped:<offer>:<keitaro type>
//                                       ledger rows, all-time, with a NULL event
//                                       type or status — one key per combo
//   conversion_events:type_conflicts:<offer>:<locked>><conflicting>
//                                       ledger rows whose Keitaro type now maps to
//                                       a different event than their locked one —
//                                       one key per combo
//   heartbeat:conversion-events-ingest  no complete ingest for over an hour
//                                       (checked by /api/cron/tracking-monitors)
//
// NOT alerted: unresolved conversions (no stage, no offers.keitaro_offer_id).
// They include legitimate non-CamMan traffic; the poll response counts them.
// Nor statusOnlyInBatch: a brand-new status-only row has a NULL event type, so
// the table-level unmapped alert already reports it.
//
// fetch_failed, invalid_rows, org_mismatch and the heartbeat are FIXED keys:
// one standing condition = one page.
//
// unmapped and type_conflicts read the whole table, all-time, and are keyed per
// PROBLEM COMBO. <offer> is the CamMan offer id, else k<Keitaro offer id>, else
// none (see unmappedAlertKey / typeConflictAlertKey). On every tick:
//   - each combo present pages ONCE, when it first appears or re-appears after
//     clearing; more rows of the same combo never page again, so a steady stream
//     of one unmapped type doesn't flood, and a row that turns into a problem by
//     UPDATE (a conflict, or an existing row turning unmapped) pages whenever its
//     combo is new;
//   - a firing key whose combo is gone is cleared (re-armed);
//   - at most LEDGER_MAX_COMBOS combos per kind are listed and paged (the
//     largest). Past the cap the rest are named as a count in each page, and no
//     key of that kind clears (a combo past the cap can't be told from a
//     resolved one).
// See decideLedgerAlerts.
//
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
} as const;

// Per-combo keys: prefix + combo (unmappedAlertKey, typeConflictAlertKey).
export const CONVERSION_ALERT_KEY_PREFIXES = {
  unmapped: "conversion_events:unmapped:",
  typeConflicts: "conversion_events:type_conflicts:",
} as const;

export const INGEST_HEARTBEAT_ALERT_KEY = "heartbeat:conversion-events-ingest";

// Combos listed — and so paged — per kind per tick, largest first. Telegram
// allows a bot about 20 messages a minute in a group, and both kinds can page on
// the same tick. A send it refuses stays pending and retries on the next tick.
export const LEDGER_MAX_COMBOS = 10;

const PREFIX = "🟠 Tier-2 conversions:";
const MAX_SAMPLES = 3;
// Telegram caps a message at 4,096 characters, and Keitaro error bodies and
// unparseable-row samples are external text of unbounded length.
const MAX_LINE = 300;
const MAX_KEY_PART = 40;

function clip(s: string): string {
  return s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s;
}

interface ComboOffer {
  offer_id: number | null; // the attributed CamMan offer
  keitaro_offer_id: number | null; // only when offer_id is null
  offer_name: string | null; // the CamMan offer's name
}

export interface UnmappedCombo extends ComboOffer {
  keitaro_type: string;
  total: number;
  last_24h: number; // by created_at
  sample_event_ids: string[]; // newest created first, at most MAX_SAMPLES
}

export interface ConflictCombo extends ComboOffer {
  locked_event_key: string | null;
  conflicting_event_key: string | null;
  total: number;
  last_24h: number; // by event_type_conflict_at (the conflict's first sighting)
  since: string | null; // earliest event_type_conflict_at, ISO-8601 UTC; rendered in ET
  sample_event_ids: string[]; // newest conflict first, at most MAX_SAMPLES
}

export interface LedgerHealth {
  unmapped_total: number; // rows, across every combo
  unmapped_combo_count: number; // every combo, including any past the cap
  unmapped_combos: UnmappedCombo[]; // the LEDGER_MAX_COMBOS largest
  conflict_total: number;
  conflict_combo_count: number;
  conflict_combos: ConflictCombo[];
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

// One key part: lowercased, anything outside [a-z0-9_-] → "_", at most
// MAX_KEY_PART characters. ":" and ">" separate the parts, so a part never
// contains them. Parts that sanitise alike share one key (decideLedgerAlerts).
function keyPart(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, MAX_KEY_PART);
}

function offerKeyPart(c: ComboOffer): string {
  if (c.offer_id !== null) return String(c.offer_id);
  return c.keitaro_offer_id !== null ? `k${c.keitaro_offer_id}` : "none";
}

// Built from the combo only — never its counts or samples — so more rows of
// the same combo keep the same key.
export function unmappedAlertKey(c: UnmappedCombo): string {
  return `${CONVERSION_ALERT_KEY_PREFIXES.unmapped}${offerKeyPart(c)}:${keyPart(c.keitaro_type)}`;
}

export function typeConflictAlertKey(c: ConflictCombo): string {
  const pair = `${keyPart(c.locked_event_key ?? "?")}>${keyPart(c.conflicting_event_key ?? "?")}`;
  return `${CONVERSION_ALERT_KEY_PREFIXES.typeConflicts}${offerKeyPart(c)}:${pair}`;
}

function windowLine(range: KeitaroReportRange): string {
  return `Window: ${range.from} → ${range.to} ${range.timezone}`;
}

// "18 min ago" under two hours; "3.1 h ago" from there.
function formatAgo(minutes: number): string {
  return minutes < 120 ? `${Math.round(minutes)} min ago` : `${(minutes / 60).toFixed(1)} h ago`;
}

function formatFetchFailedAlert(outcome: IngestOutcome, lastSuccessAgeMinutes: number | null): string {
  const range = outcome.kind === "threw" ? outcome.range : outcome.result.range;
  const error =
    outcome.kind === "threw" ? `ingest threw: ${outcome.error}` : (outcome.result.error ?? "(no error message)");
  return [
    `${PREFIX} the conversion ledger ingest keeps failing. Nothing from the failed windows was written.`,
    windowLine(range),
    `Error: ${clip(error)}`,
    `Last complete ingest: ${lastSuccessAgeMinutes === null ? "never recorded" : formatAgo(lastSuccessAgeMinutes)}.`,
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

function offerLabel(c: ComboOffer): string {
  if (c.offer_id !== null) return `${clip(c.offer_name ?? "?")} (offer ${c.offer_id})`;
  return c.keitaro_offer_id !== null ? `Keitaro offer ${c.keitaro_offer_id} (no CamMan offer)` : "no offer";
}

function samplesLine(ids: readonly string[]): string {
  return clip(`Sample Keitaro event ids: ${ids.slice(0, MAX_SAMPLES).join(", ")}`);
}

// Appended to every page of a kind whose combos exceed the cap; [] otherwise.
function pastCapLine(kind: string, comboCount: number, listed: number): string[] {
  const more = comboCount - listed;
  return more > 0
    ? [
        `${more} more ${kind} combo(s) are not listed or paged (cap: ${LEDGER_MAX_COMBOS} combos per kind). No ${kind} alert clears while the cap is exceeded.`,
      ]
    : [];
}

function formatUnmappedAlert(c: UnmappedCombo, pastCap: string[]): string {
  return [
    `${PREFIX} ${c.total} conversion(s) for ${offerLabel(c)} with Keitaro type ${clip(c.keitaro_type)} have no event-type mapping (${c.last_24h} created in the last 24h).`,
    "They are stored but never counted as a purchase or as revenue.",
    samplesLine(c.sample_event_ids),
    "Fix: add a conversion_event_mappings row for this offer or its network and this Keitaro type; rows inside the 7-day live window heal on the next tick. A row first seen through a status-only rule (e.g. rejected) has no event type to heal into and needs one set by SQL. See docs/04-features/conversion-events.md.",
    ...pastCap,
  ].join("\n");
}

function formatTypeConflictAlert(c: ConflictCombo, pastCap: string[]): string {
  return [
    `${PREFIX} ${c.total} conversion(s) for ${offerLabel(c)} changed Keitaro type to one that maps to a different event: locked ${clip(c.locked_event_key ?? "?")} → now ${clip(c.conflicting_event_key ?? "?")} (${c.last_24h} first seen in the last 24h). The locked event type was kept.`,
    `First seen: ${formatCampaignDateTime(c.since)}`,
    samplesLine(c.sample_event_ids),
    'Decide which event is right: see "Event-type conflicts" in docs/04-features/conversion-events.md.',
    ...pastCap,
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

// Decisions from the whole-ledger combo read (all-time, all orgs) and the keys
// currently firing under the two combo prefixes.
//   every listed combo → firing on its key. notifyOnTransition pages only on the
//     transition, so a combo already firing sends nothing.
//   a firing key under a prefix that no listed combo builds → ok (cleared, so
//     the combo pages again if it comes back) — unless that kind is past the
//     cap, where nothing of that kind is cleared.
// Combos whose keys sanitise alike get one decision, with the first (largest)
// combo's text. Keys outside both prefixes get no decision.
export function decideLedgerAlerts(h: LedgerHealth, firingKeys: readonly string[]): ConversionAlertDecision[] {
  const P = CONVERSION_ALERT_KEY_PREFIXES;
  const unmappedPastCap = pastCapLine("unmapped", h.unmapped_combo_count, h.unmapped_combos.length);
  const conflictPastCap = pastCapLine("type-conflict", h.conflict_combo_count, h.conflict_combos.length);
  const present = new Map<string, string>(); // key → page text
  for (const c of h.unmapped_combos) {
    const key = unmappedAlertKey(c);
    if (!present.has(key)) present.set(key, formatUnmappedAlert(c, unmappedPastCap));
  }
  for (const c of h.conflict_combos) {
    const key = typeConflictAlertKey(c);
    if (!present.has(key)) present.set(key, formatTypeConflictAlert(c, conflictPastCap));
  }
  const clearable = (key: string) =>
    (key.startsWith(P.unmapped) && unmappedPastCap.length === 0) ||
    (key.startsWith(P.typeConflicts) && conflictPastCap.length === 0);
  return [
    ...[...present].map(([alertKey, text]): ConversionAlertDecision => ({ alertKey, state: "firing", text })),
    ...firingKeys
      .filter((key) => !present.has(key) && clearable(key))
      .map((alertKey): ConversionAlertDecision => ({ alertKey, state: "ok" })),
  ];
}

// ── DB: ledger health, alert application, ingest heartbeat ──────────────────

type Send = (text: string) => Promise<boolean>;

// One statement per kind: the LEDGER_MAX_COMBOS largest combos with their
// counts and samples, plus the combo count and row total over EVERY combo
// (window aggregates over the groups, computed before the LIMIT). Each WHERE is
// written EXACTLY as its partial index's predicate (migration 0181), so the
// planner can read only that small index's rows however large the ledger grows.
// The per-combo sample array aggregates every row of its combo before slicing:
// fine for problem rows, which the partial index keeps few. <offer> is offer_id,
// else keitaro_offer_id (the CASE drops the Keitaro id when a CamMan offer is
// set), matching offerKeyPart. Exported so scripts/test-conversion-monitor-db.ts
// can EXPLAIN the very statements this module runs.
export const UNMAPPED_COMBOS_SQL = sql`
  SELECT ce.offer_id,
         CASE WHEN ce.offer_id IS NULL THEN ce.keitaro_offer_id END AS keitaro_offer_id,
         ce.keitaro_type,
         min(o.name) AS offer_name,
         count(*)::int AS total,
         count(*) FILTER (WHERE ce.created_at >= now() - interval '24 hours')::int AS last_24h,
         (array_agg(ce.keitaro_event_id ORDER BY ce.created_at DESC, ce.id DESC))[1:${MAX_SAMPLES}] AS sample_event_ids,
         count(*) OVER ()::int AS combo_count,
         (sum(count(*)) OVER ())::int AS row_total
  FROM conversion_events ce
  LEFT JOIN offers o ON o.id = ce.offer_id
  WHERE ce.event_type_id IS NULL OR ce.status IS NULL
  GROUP BY 1, 2, 3
  ORDER BY total DESC, 1 NULLS LAST, 2 NULLS LAST, 3
  LIMIT ${LEDGER_MAX_COMBOS}`;

export const CONFLICT_COMBOS_SQL = sql`
  SELECT ce.offer_id,
         CASE WHEN ce.offer_id IS NULL THEN ce.keitaro_offer_id END AS keitaro_offer_id,
         lt.key AS locked_event_key,
         mt.key AS conflicting_event_key,
         min(o.name) AS offer_name,
         count(*)::int AS total,
         count(*) FILTER (WHERE ce.event_type_conflict_at >= now() - interval '24 hours')::int AS last_24h,
         to_char(min(ce.event_type_conflict_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS since,
         (array_agg(ce.keitaro_event_id ORDER BY ce.event_type_conflict_at DESC NULLS LAST, ce.id DESC))[1:${MAX_SAMPLES}] AS sample_event_ids,
         count(*) OVER ()::int AS combo_count,
         (sum(count(*)) OVER ())::int AS row_total
  FROM conversion_events ce
  LEFT JOIN offers o ON o.id = ce.offer_id
  LEFT JOIN event_types lt ON lt.id = ce.event_type_id
  LEFT JOIN event_types mt ON mt.id = ce.conflicting_event_type_id
  WHERE ce.conflicting_event_type_id IS NOT NULL
  GROUP BY 1, 2, 3, 4
  ORDER BY total DESC, 1 NULLS LAST, 2 NULLS LAST, 3, 4
  LIMIT ${LEDGER_MAX_COMBOS}`;

type ComboTotals = { combo_count: number; row_total: number };

// Whole ledger, all orgs (the alerts are global). Two small reads per cron tick.
export async function readLedgerHealth(dbc: DbOrTx): Promise<LedgerHealth> {
  const unmapped = (await dbc.execute(UNMAPPED_COMBOS_SQL)) as unknown as (UnmappedCombo & ComboTotals)[];
  const conflicts = (await dbc.execute(CONFLICT_COMBOS_SQL)) as unknown as (ConflictCombo & ComboTotals)[];
  return {
    unmapped_total: unmapped[0]?.row_total ?? 0,
    unmapped_combo_count: unmapped[0]?.combo_count ?? 0,
    unmapped_combos: unmapped.map((r) => ({
      offer_id: r.offer_id,
      keitaro_offer_id: r.keitaro_offer_id,
      offer_name: r.offer_name,
      keitaro_type: r.keitaro_type,
      total: r.total,
      last_24h: r.last_24h,
      sample_event_ids: r.sample_event_ids,
    })),
    conflict_total: conflicts[0]?.row_total ?? 0,
    conflict_combo_count: conflicts[0]?.combo_count ?? 0,
    conflict_combos: conflicts.map((r) => ({
      offer_id: r.offer_id,
      keitaro_offer_id: r.keitaro_offer_id,
      offer_name: r.offer_name,
      locked_event_key: r.locked_event_key,
      conflicting_event_key: r.conflicting_event_key,
      total: r.total,
      last_24h: r.last_24h,
      since: r.since,
      sample_event_ids: r.sample_event_ids,
    })),
  };
}

// The keys currently firing under the two combo prefixes. starts_with needs no
// escaping (both prefixes contain "_", a LIKE wildcard).
async function readFiringLedgerKeys(dbc: DbOrTx): Promise<string[]> {
  const P = CONVERSION_ALERT_KEY_PREFIXES;
  const rows = (await dbc.execute(sql`
    SELECT alert_key FROM alert_state
    WHERE state = 'firing'
      AND (starts_with(alert_key, ${P.unmapped}::text) OR starts_with(alert_key, ${P.typeConflicts}::text))
  `)) as unknown as { alert_key: string }[];
  return rows.map((r) => r.alert_key);
}

async function applyDecisions(
  dbc: DbOrTx,
  decisions: readonly ConversionAlertDecision[],
  send: Send | undefined,
): Promise<void> {
  for (const d of decisions) {
    // Both helpers are best-effort and never throw; org-less because the
    // conversion alerts are global.
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
// that THREW (the route passes { kind: "threw" }). The ledger alerts are
// evaluated on EVERY tick, failed ones included: they read the table, not the
// batch. `send` is injectable only for the DB test.
//
// Failure contract — the READS are not best-effort and propagate; the caller
// must catch (the poll route reports `monitor: …` and does not stamp the
// heartbeat). The alert writes are best-effort and never throw.
//   - Heartbeat-age read (failed ticks only, for the fetch_failed debounce): it
//     runs before any decision, so if it throws NOTHING pages and the ledger
//     alerts are skipped for that tick.
//   - The ingest decisions are applied next, so a failed tick past the debounce
//     still pages even if the ledger combo or firing-key read then throws; only
//     the ledger alerts are skipped for that tick.
export async function evaluateConversionAlerts(
  dbc: DbOrTx,
  outcome: IngestOutcome,
  opts: { send?: Send } = {},
): Promise<{
  health: LedgerHealth;
  ingestDecisions: ConversionAlertDecision[];
  ledgerDecisions: ConversionAlertDecision[];
}> {
  const lastSuccessAgeMinutes = ingestFailed(outcome) ? await readLastSuccessAgeMinutes(dbc) : null;
  const ingestDecisions = decideIngestAlerts(outcome, lastSuccessAgeMinutes);
  await applyDecisions(dbc, ingestDecisions, opts.send);
  const health = await readLedgerHealth(dbc);
  const ledgerDecisions = decideLedgerAlerts(health, await readFiringLedgerKeys(dbc));
  await applyDecisions(dbc, ledgerDecisions, opts.send);
  return { health, ingestDecisions, ledgerDecisions };
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
