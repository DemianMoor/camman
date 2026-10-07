import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { decryptCredentialKey } from "@/lib/sends/provider-credential";
import { optOutBreakerAlertText, type OptOutRateCheckResult } from "@/lib/sends/optout-rate-breaker";
import { captureTxrPollDlrBatch, type TxrPollDlrBatchRow } from "@/lib/sends/textrequest-dlr";
import { captureTxrInboundEvent, processTextrequestOptOut } from "@/lib/sends/textrequest-optout";
import { textrequestBaseUrl } from "@/lib/sends/providers/textrequest";

// Text Request messages-poll — the DLR reconciliation backstop behind the
// real-time per-message status_callback (Phase 3a). Reads
// GET /dashboards/{id}/messages over a rolling window and idempotently captures
// each outbound message's delivery status into textrequest_dlr_events
// (method='poll'), reconciling it to its stage_send.
//
// WHY a backstop at all: the callback URL is only threaded when the sending
// number's credential has an inbound_webhook_token AND NEXT_PUBLIC_SITE_URL is
// set (lib/sends/drain.ts) — otherwise no callback is requested at all — and a
// callback can be lost in flight. This poll re-derives the same facts from Text
// Request's own record, so a missing callback degrades latency, not correctness.
//
// Contracts below were confirmed live (scripts/probe-textrequest-api*.ts, recon
// 2026-07-25) against Text Request's OpenAPI spec, not inferred.

// Rolling lookback. Generous enough to survive a couple of missed ticks at the
// 15-min cron cadence without being so wide that a busy account re-reads a day
// of traffic every tick.
const DEFAULT_LOOKBACK_HOURS = 6;
// Small forward skew so a message written a second ago (or a slight clock skew
// between us and Text Request) is never just outside the window's end.
const END_SKEW_MINUTES = 5;
// TR silently CLAMPS page_size at 1000: asking for 2000 or 5000 returns 1000
// rows and echoes meta.page_size=1000 (verified live 2026-08-21). 1000 is
// therefore the ceiling worth asking for — half the requests per tick, and
// double the effective page-cap headroom.
const PAGE_SIZE = 1000;
// Hard ceiling on pages per (dashboard, DIRECTION, tick). Outbound and inbound
// are walked separately, so each gets its OWN budget: 20 x 1000 = 20K messages
// per direction. The separation is the point — on 2026-08-21 dashboard 68093
// sent 10,000 messages in 46 minutes and overflowed the shared 10K budget at 21
// pages; under one budget a big campaign can push STOP replies out of the read.
// Also a backstop against an unbounded loop if `meta.total_items` ever
// misbehaves. Hitting it is reported (result.truncated + a warn log line),
// never silent. Not a Telegram alert: a capped walk keeps its owed range and
// catches up on the next runs, so the alert paged the channel for routine
// catch-up. Actually falling behind is alerted by textrequest-poll-health.ts
// (no complete pass in N runs).
const MAX_PAGES = 20;

// TR emits UTC timestamps with NO timezone designator ("2026-07-25T09:39:35.227").
// `new Date(...)` on that string applies the RUNTIME's local zone, which would
// shift every timestamp by the server's offset — the exact bug class that
// silently zeroed stage opt-out counters when TextHub's Mountain-time
// `received_at` was parsed as UTC (see lib/sends/texthub-inbox.ts). Append the
// 'Z' unless the string already carries a designator or offset.
export function parseTxrUtcTimestamp(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const d = new Date(hasZone ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface TxrMessagesWindow {
  start_date: string; // ISO-8601 UTC
  end_date: string; // ISO-8601 UTC
}

// Pure rolling-UTC window. Deliberately NOT the ET calendar-day arithmetic Ahoi's
// CDR poll needs (computeCdrPollWindow): Ahoi's export is timestamped in ET, so it
// has a DST hazard to dodge; Text Request's `start_date`/`end_date` filters and
// its `*_utc` fields are UTC on both sides, so plain subtraction is exact and a
// timezone helper here would add a DST edge case rather than remove one.
export function computeTxrMessagesWindow(
  now: Date = new Date(),
  lookbackHours: number = DEFAULT_LOOKBACK_HOURS,
): TxrMessagesWindow {
  return {
    start_date: new Date(now.getTime() - lookbackHours * 3600_000).toISOString(),
    end_date: new Date(now.getTime() + END_SKEW_MINUTES * 60_000).toISOString(),
  };
}

// One row of GET /dashboards/{id}/messages (confirmed live).
export interface TxrMessageRow {
  dashboard_phone: string | null;
  customer_phone: string | null;
  customer_friendly_name: string | null;
  segments_count: number | null;
  message_id: string;
  body: string | null;
  // 'S' = sent from the dashboard (outbound), 'R' = received from the contact.
  message_direction: string | null;
  message_timestamp_utc: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
}

export type TxrMessagesPage =
  | { ok: true; items: TxrMessageRow[]; totalItems: number }
  | { ok: false; error: string };

export type TxrMessagesFetcher = (opts: {
  apiKey: string;
  dashboardId: string;
  window: TxrMessagesWindow;
  page: number;
  pageSize: number;
  direction?: "S" | "R";
  sort?: "desc" | "asc";
}) => Promise<TxrMessagesPage>;

async function realFetchTxrMessages(opts: {
  apiKey: string;
  dashboardId: string;
  window: TxrMessagesWindow;
  page: number;
  pageSize: number;
  direction?: "S" | "R";
  sort?: "desc" | "asc";
}): Promise<TxrMessagesPage> {
  try {
    const u = new URL(`${textrequestBaseUrl()}/dashboards/${encodeURIComponent(opts.dashboardId)}/messages`);
    // Param NAMES matter: `start_date`/`end_date` are the documented filters and
    // DO narrow the result set. Undocumented guesses (`start`, `startDate`,
    // `since`) are silently IGNORED by TR — a poll built on one of those would
    // believe it asked for 6 hours and quietly receive the account's entire
    // history. Verified both ways in recon.
    u.searchParams.set("start_date", opts.window.start_date);
    u.searchParams.set("end_date", opts.window.end_date);
    u.searchParams.set("page", String(opts.page));
    u.searchParams.set("page_size", String(opts.pageSize));
    // Server-side direction filter (the documented spelling is
    // `message_direction`; a bare `direction` is ignored).
    if (opts.direction) u.searchParams.set("message_direction", opts.direction);
    // Newest-first. Also absent from TR's OpenAPI spec, but honored live AND
    // validated as an enum: an unrecognized value is rejected with HTTP 400
    // rather than silently ignored (verified 2026-08-21). So if TR ever drops
    // it, this fails LOUDLY into the unsorted fallback in pollTxrMessages
    // instead of quietly handing us the wrong end of the window.
    if (opts.sort) u.searchParams.set("sort", opts.sort);

    const res = await fetch(u.toString(), {
      method: "GET",
      headers: { "x-api-key": opts.apiKey, Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const raw = await res.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "non-JSON response" };
    }
    const items = Array.isArray(parsed.items) ? (parsed.items as TxrMessageRow[]) : [];
    const meta = (parsed.meta ?? null) as { total_items?: number } | null;
    return { ok: true, items: items.filter((m) => m && typeof m.message_id === "string"), totalItems: meta?.total_items ?? items.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
}

// Page order. Both planners walk NEWEST-first, because a backstop's whole job is
// to catch what just happened: if the cap bites, what gets dropped must be the
// OLDEST slice of the window, which earlier ticks already covered.
//
// planTxrSortedWalk is the primary path. With `sort=desc` the API hands us
// newest-first, so page 0 IS the newest page and the walk runs forward. That
// also makes the walk independent of `meta.total_items` being exactly right:
// a miscount can cost a page at the tail, never the newest data.
//
// planTxrPageWalk is the fallback for a refused `sort`. TR's default order is
// documented (and live-confirmed) as oldest->newest, so newest-first there
// means reading page 0 for `meta.total_items` and walking the LAST page down.
//
// Rows can shift between requests if new messages arrive mid-walk (page
// boundaries move). That's accepted: capture is idempotent, windows overlap
// tick-to-tick, and a row missed once is picked up next tick. Under sort=desc
// the shift is strictly older-ward, into pages the walk has not read yet, so
// it costs a re-read and never a skip.
export function planTxrSortedWalk(totalItems: number, pageSize: number, maxPages: number): {
  pages: number[];
  truncated: boolean;
} {
  if (totalItems <= 0) return { pages: [], truncated: false };
  const pageCount = Math.ceil(totalItems / pageSize);
  const pages: number[] = [];
  for (let p = 0; p < pageCount && pages.length < maxPages; p++) pages.push(p);
  return { pages, truncated: pageCount > maxPages };
}

export function planTxrPageWalk(totalItems: number, pageSize: number, maxPages: number): {
  pages: number[];
  truncated: boolean;
} {
  if (totalItems <= 0) return { pages: [], truncated: false };
  const lastPage = Math.max(0, Math.ceil(totalItems / pageSize) - 1);
  const pages: number[] = [];
  for (let p = lastPage; p >= 0 && pages.length < maxPages; p--) pages.push(p);
  return { pages, truncated: lastPage + 1 > maxPages };
}

export interface TxrMessagesPollResult {
  credentials_polled: number;
  dashboards_polled: number;
  fetched: number; // rows returned across all pages
  outbound_with_status: number; // 'S' rows carrying a delivery_status
  captured: number; // newly captured DLR events
  dupe: number; // already captured (idempotent skip)
  matched: number; // reconciled to a stage_send
  unmatched: number;
  // Inbound ('R') rows — the opt-out backstop (Phase 4 signal 3a).
  inbound_seen: number;
  inbound_captured: number; // new textrequest_inbound_events rows
  inbound_dupe: number; // same message GUID already captured (webhook got it first)
  inbound_known: number; // of inbound_dupe: skipped by the per-page lookup (captured AND processed)
  inbound_suppressed: number; // resulted in a real opt-out
  truncated: boolean; // a page cap bit somewhere
  sort_fallbacks: number; // walks that had to drop `sort=desc` and read oldest-first
  error: string | null;
  /** Every walk this run made, with how far it got. */
  walks: TxrPollWalkReport[];
  /** Ranges left unread by this run. A cron (stateful) run reads them first next time. */
  owed: { dashboard_id: string; direction: "R" | "S"; from: string; to: string }[];
}

interface TxrPollTarget {
  credential_id: number;
  org_id: string;
  provider_id: number;
  api_key: string;
  dashboard_id: string;
}

// Resolve (credential, dashboard) pairs to poll from the numbers we actually
// send from: provider_phones bound to a txr credential AND carrying a
// dashboard_id. Archived numbers are skipped. Deliberately NOT "every dashboard
// on the account" (GET /dashboards) — an account can hold dashboards this app
// never sends through, and polling those would capture a third party's traffic.
export async function resolveTxrPollTargets(
  database: typeof db,
  opts?: { orgId?: string },
): Promise<TxrPollTarget[]> {
  const orgFilter = opts?.orgId ? sql`AND pc.org_id = ${opts.orgId}` : sql``;
  const rows = (await database.execute(sql`
    SELECT DISTINCT pc.id AS credential_id, pc.org_id AS org_id, pc.provider_id AS provider_id,
           pc.api_key AS api_key, pc.api_key_encrypted AS api_key_encrypted,
           ph.dashboard_id AS dashboard_id
    FROM provider_phones ph
    JOIN provider_credentials pc ON pc.id = ph.credential_id AND pc.org_id = ph.org_id
    JOIN sms_providers p ON p.id = pc.provider_id AND p.org_id = pc.org_id
    WHERE p.sms_provider_id = 'txr'
      AND ph.dashboard_id IS NOT NULL
      AND ph.archived_at IS NULL
      AND ph.status = 'active'
      ${orgFilter}
  `)) as unknown as {
    credential_id: number;
    org_id: string;
    provider_id: number;
    api_key: string | null;
    api_key_encrypted: string | null;
    dashboard_id: string;
  }[];

  const out: TxrPollTarget[] = [];
  for (const r of rows) {
    // Dual-read the credential (migration 0110). A row that won't decrypt is a
    // broken credential: warn and skip it rather than crash the whole poll.
    // Never log the key or the decryption error.
    let api_key: string | null;
    try {
      api_key = decryptCredentialKey(r);
    } catch {
      console.warn(`pollTxrMessages: credential ${r.credential_id} failed to decrypt, skipping`);
      continue;
    }
    if (!api_key) {
      console.warn(`pollTxrMessages: credential ${r.credential_id} has no usable api key, skipping`);
      continue;
    }
    out.push({
      credential_id: r.credential_id,
      org_id: r.org_id,
      provider_id: r.provider_id,
      api_key,
      dashboard_id: r.dashboard_id,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-dashboard poll state (cron_locks rows — no migration; ClickUp 869fcqhcu)
// ---------------------------------------------------------------------------
//
//   textrequest-poll:pass:<dashboard>:<R|S>      last time a walk of that dashboard
//                                                and direction read EVERYTHING it
//                                                was owed (alerts: textrequest-poll-health.ts)
//   textrequest-poll:gap-from:<dashboard>:<R|S>  a range a run was owed but did not
//   textrequest-poll:gap-to:<dashboard>:<R|S>    finish reading (time budget, page
//                                                cap or a failed page/write). Read
//                                                FIRST on the next run, until empty.
//
// ⚠️ WHY THE OWED RANGE EXISTS. Each walk now has a time budget (inbound 20 s,
// outbound the time left before 45 s) so one busy dashboard or one STOP flood
// cannot starve the rest: on 2026-10-05 dashboard 68093 used the whole 60 s
// every run and 68804 was never reached, and the contacts poll and webhook
// health never ran. A budget means a walk can stop early — and before this, a
// walk that stopped early simply lost its oldest pages: the next run starts from
// the newest again, and after 6 h those messages leave the window for good.
// Recording the unread range and reading it first next time makes a cut-short
// walk LATE, never lossy. Owed ranges are read OLDEST-first and the owed start
// never moves backwards (txrMergeOwed), so a backlog shrinks every run instead of
// re-reading its newest pages; time left before the deadline goes back to the
// dashboards that still owe. Text Request serves the full message history
// (verified 2026-10-06 back to the first send), so an old range is still readable.
//
// ⚠️ ONLY THE CRON OWNS THIS STATE (`stateful: true`). A manual "poll now" run is
// not under the cron lease and can overlap a cron run; if it could delete an owed
// range or stamp a pass from what IT read, it could clear a range the cron wrote
// in the meantime. Manual runs therefore neither read nor write it.

export function txrPassKey(dashboardId: string, direction: "R" | "S"): string {
  return `textrequest-poll:pass:${dashboardId}:${direction}`;
}
const gapFromKey = (d: string, dir: "R" | "S") => `textrequest-poll:gap-from:${d}:${dir}`;
const gapToKey = (d: string, dir: "R" | "S") => `textrequest-poll:gap-to:${d}:${dir}`;

async function readStamps(database: typeof db, keys: string[]): Promise<Map<string, Date>> {
  if (keys.length === 0) return new Map();
  const rows = (await database.execute(sql`
    SELECT job_name, watermark FROM cron_locks
    WHERE job_name = ANY(${sql`ARRAY[${sql.join(keys.map((k) => sql`${k}`), sql`, `)}]::text[]`})
      AND watermark IS NOT NULL
  `)) as unknown as { job_name: string; watermark: string | Date }[];
  return new Map(rows.map((r) => [r.job_name, new Date(r.watermark)]));
}

async function writeStamp(database: typeof db, key: string, at: Date): Promise<void> {
  // Bound as text: postgres-js drops microseconds from a bound timestamptz, and
  // these are compared, not displayed.
  await database.execute(sql`
    INSERT INTO cron_locks (job_name, watermark) VALUES (${key}, ${at.toISOString()}::timestamptz)
    ON CONFLICT (job_name) DO UPDATE SET watermark = EXCLUDED.watermark
  `);
}

async function deleteStamps(database: typeof db, keys: string[]): Promise<void> {
  await database.execute(sql`
    DELETE FROM cron_locks
    WHERE job_name = ANY(${sql`ARRAY[${sql.join(keys.map((k) => sql`${k}`), sql`, `)}]::text[]`})
  `);
}

export interface TxrRange {
  from: Date;
  to: Date;
}

/**
 * What a walk still owes after stopping early. A sorted walk reads newest-first,
 * so everything OLDER than the oldest row read is unread: [window start, oldest
 * read + 1 s]. The second of overlap re-reads the boundary timestamp (cheap — the
 * capture dedups) rather than risking a row that shares it. Nothing read at all ⇒
 * the whole window. Pure.
 */
export function txrUnreadRange(walkFrom: Date, walkTo: Date, oldestRead: Date | null): TxrRange {
  if (!oldestRead) return { from: walkFrom, to: walkTo };
  const to = new Date(Math.min(walkTo.getTime(), oldestRead.getTime() + 1000));
  return { from: walkFrom, to: to < walkFrom ? walkFrom : to };
}

/**
 * What an owed range still owes after an OLDEST-first walk that stopped early:
 * everything from the newest row read onwards. The start is inclusive, so rows
 * sharing that timestamp are read again (the capture dedups) rather than lost.
 * It never moves backwards: no row read ⇒ the range is unchanged. Pure.
 */
export function txrOwedAfterAscending(owed: TxrRange, newestRead: Date | null): TxrRange {
  if (!newestRead || newestRead <= owed.from) return owed;
  return { from: newestRead < owed.to ? newestRead : owed.to, to: owed.to };
}

/**
 * The owed range after one run, from what was owed before (`prior`), what the
 * owed-range walk left (`gapAfter`, null when it finished) and what the window
 * walk left (`windowOwed`, null when it finished). Pure.
 *
 * ⚠️ THE OWED START NEVER MOVES BACKWARDS. Everything before an owed start has
 * been read; a window walk that got no time owes the whole 6 h window, and
 * merging that naively (min of the starts) would re-owe time just read
 * oldest-first — the 68804 loop of 2026-10-06 in another shape. So the window
 * may only push the owed END later:
 *   · owed range still open ⇒ [its new start, max(its end, window's end)]
 *   · owed range finished this run ⇒ the window's leftover, clipped so it starts
 *     no earlier than the end just read
 *   · no owed range before ⇒ the window's leftover as is (first cut-short run)
 */
export function txrMergeOwed(
  prior: TxrRange | null,
  gapAfter: TxrRange | null,
  windowOwed: TxrRange | null,
): TxrRange | null {
  if (gapAfter) {
    const to = windowOwed && windowOwed.to > gapAfter.to ? windowOwed.to : gapAfter.to;
    return { from: gapAfter.from, to };
  }
  if (!windowOwed) return null;
  const from = prior && prior.to > windowOwed.from ? prior.to : windowOwed.from;
  return from < windowOwed.to ? { from, to: windowOwed.to } : null;
}

/**
 * Walk order for one direction: the dashboard whose last COMPLETE pass is oldest
 * goes first; never-completed dashboards before all of them. Ties keep input
 * order. Pure.
 */
export function txrWalkOrder<T extends { dashboard_id: string }>(
  targets: T[],
  lastPass: Map<string, Date>,
  direction: "R" | "S",
): T[] {
  return targets
    .map((t, i) => ({ t, i, at: lastPass.get(txrPassKey(t.dashboard_id, direction))?.getTime() ?? -Infinity }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.t);
}

/**
 * The time a dashboard's walks may run until: an equal share of what is left
 * before the deadline, split over the dashboards not yet walked. A dashboard
 * that finishes early hands its unused time to the ones after it. Pure.
 */
export function txrBudgetEnd(nowMs: number, deadlineAt: number, dashboardsLeft: number): number {
  return nowMs + Math.max(0, deadlineAt - nowMs) / Math.max(1, dashboardsLeft);
}

export interface TxrPollWalkReport {
  dashboard_id: string;
  direction: "R" | "S";
  kind: "window" | "gap";
  from: string;
  to: string;
  pages_read: number;
  complete: boolean;
  /** Why the walk stopped short; null when complete. */
  stopped: null | "budget" | "page_cap" | "fetch_error" | "write_error";
}

export interface TxrInboundRowOutcome {
  kind: "dupe" | "new";
  suppressed: boolean;
  breakerTrip: { campaignId: number; result: OptOutRateCheckResult } | null;
}

// ONE inbound row: capture + opt-out processing in ONE transaction, exactly as
// the poll has always done it. Exported so scripts/verify-txr-inbound-prefilter.ts
// can run the unfiltered path row by row against the same page.
//
// ⚠️ The transaction is what makes a poll-captured row ALWAYS processed:
// processTextrequestOptOut stamps result + processed_at in the same
// transaction as the capture, so a failure rolls the capture back too. (The
// msg_received WEBHOOK captures first and processes in a second transaction —
// a webhook row can be stored with processed_at NULL. Neither path reprocesses
// such a row: its capture here conflicts and counts as a dupe.)
export async function processTxrInboundRow(
  database: typeof db,
  t: { org_id: string; credential_id: number; provider_id: number },
  m: TxrMessageRow,
): Promise<TxrInboundRowOutcome> {
  return database.transaction(async (tx) => {
    const captured = await captureTxrInboundEvent(tx, {
      orgId: t.org_id,
      credentialId: t.credential_id,
      providerId: t.provider_id,
      channel: "poll_messages",
      method: "poll",
      sourceNumber: m.customer_phone,
      destinationNumber: m.dashboard_phone,
      message: m.body,
      // Same GUID the msg_received webhook carries, so whichever
      // channel arrives second is dropped by the unique index rather
      // than double-writing the opt-out.
      providerUuid: m.message_id,
      optedOutUtc: null,
      rawBody: JSON.stringify(m),
      receivedAt: parseTxrUtcTimestamp(m.message_timestamp_utc) ?? new Date(),
    });
    if (!captured) return { kind: "dupe" as const, suppressed: false, breakerTrip: null };
    const r = await processTextrequestOptOut(tx, {
      eventId: captured.id,
      orgId: t.org_id,
      sourceNumber: m.customer_phone,
      message: m.body,
      channel: "poll_messages",
      receivedAt: parseTxrUtcTimestamp(m.message_timestamp_utc) ?? new Date(),
    });
    return {
      kind: "new" as const,
      suppressed: r.kind === "suppressed",
      breakerTrip: r.kind === "suppressed" ? r.breakerTrip : null,
    };
  });
}

/**
 * Of these inbound message GUIDs, the ones already captured AND processed
 * (processed_at IS NOT NULL — stamped together with `result` by
 * processTextrequestOptOut, in the same transaction). Served by the
 * (provider_id, provider_uuid) partial unique index.
 */
export async function txrProcessedInboundIds(
  database: typeof db,
  providerId: number,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = (await database.execute(sql`
    SELECT provider_uuid FROM textrequest_inbound_events
    WHERE provider_id = ${providerId}
      AND provider_uuid = ANY(${sql`ARRAY[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::text[]`})
      AND processed_at IS NOT NULL
  `)) as unknown as { provider_uuid: string }[];
  return new Set(rows.map((r) => r.provider_uuid));
}

export async function pollTxrMessages(
  database: typeof db,
  opts?: {
    orgId?: string;
    fetchMessages?: TxrMessagesFetcher;
    now?: Date;
    lookbackHours?: number;
    pageSize?: number;
    maxPages?: number;
    /** Which walks to run. The cron calls inbound and outbound separately, with
     *  the contacts poll and webhook health in between. Default both. */
    directions?: ("R" | "S")[];
    /** Epoch ms. No page is started past it (split per dashboard). Omitted
     *  (tests, scripts) ⇒ no budget. */
    deadlineAt?: number;
    /** Read and write the owed ranges and pass stamps. ONLY the cron run sets
     *  this (see the header above); default false. */
    stateful?: boolean;
    /** Injectable clock for the budget, so tests need not sleep. */
    clock?: () => number;
  },
): Promise<TxrMessagesPollResult> {
  const fetchMessages = opts?.fetchMessages ?? realFetchTxrMessages;
  const pageSize = opts?.pageSize ?? PAGE_SIZE;
  const maxPages = opts?.maxPages ?? MAX_PAGES;
  const clock = opts?.clock ?? Date.now;
  const directions = opts?.directions ?? ["R", "S"];
  const stateful = opts?.stateful ?? false;
  const window = computeTxrMessagesWindow(opts?.now ?? new Date(), opts?.lookbackHours);
  const targets = await resolveTxrPollTargets(database, { orgId: opts?.orgId });

  const res: TxrMessagesPollResult = {
    credentials_polled: new Set(targets.map((t) => t.credential_id)).size,
    dashboards_polled: 0,
    fetched: 0,
    outbound_with_status: 0,
    captured: 0,
    dupe: 0,
    matched: 0,
    unmatched: 0,
    inbound_seen: 0,
    inbound_captured: 0,
    inbound_dupe: 0,
    inbound_known: 0,
    inbound_suppressed: 0,
    truncated: false,
    sort_fallbacks: 0,
    error: null,
    walks: [],
    owed: [],
  };
  const breakerTrips: { campaignId: number; result: OptOutRateCheckResult }[] = [];
  const dashboardsSeen = new Set<string>();

  // One walk of one (dashboard, direction) over [w.start_date, w.end_date].
  //   kind "window" — the rolling 6 h window, NEWEST-first (fresh receipts and
  //                   STOPs land first); a cut-short walk owes everything older
  //                   than the oldest row it read.
  //   kind "gap"    — an owed range, OLDEST-first (sort=asc), so every run moves
  //                   the owed start forward and never re-reads the same newest
  //                   pages (2026-10-06, dashboard 68804: a newest-first owed
  //                   walk re-read its newest ~8 pages every run and never
  //                   reached 09:49). A cut-short walk owes everything newer
  //                   than the newest row it read.
  const walk = async (
    t: TxrPollTarget,
    direction: "R" | "S",
    w: TxrMessagesWindow,
    kind: "window" | "gap",
    budgetEnd: number | null,
  ): Promise<{ complete: boolean; oldestRead: Date | null; newestRead: Date | null }> => {
    if (!dashboardsSeen.has(t.dashboard_id)) {
      dashboardsSeen.add(t.dashboard_id);
      res.dashboards_polled++;
    }
    const ascending = kind === "gap";
    const report: TxrPollWalkReport = {
      dashboard_id: t.dashboard_id,
      direction,
      kind,
      from: w.start_date,
      to: w.end_date,
      pages_read: 0,
      complete: false,
      stopped: null,
    };
    res.walks.push(report);
    const outOfTime = () => budgetEnd !== null && clock() >= budgetEnd;
    let oldestRead: Date | null = null;
    let newestRead: Date | null = null;
    const stop = (why: TxrPollWalkReport["stopped"]) => {
      report.stopped = why;
      return { complete: false, oldestRead, newestRead };
    };
    if (outOfTime()) return stop("budget");

    const label = direction === "S" ? "outbound" : "inbound";
    const req = { apiKey: t.api_key, dashboardId: t.dashboard_id, window: w, pageSize, direction };

    // Ask for the order explicitly instead of relying on TR's default, so page 0
    // is the first page of the walk whatever meta.total_items says. Page 0
    // doubles as the head request that sizes the walk.
    let sort: "desc" | "asc" | undefined = ascending ? "asc" : "desc";
    let head = await fetchMessages({ ...req, page: 0, sort });
    if (!head.ok) {
      // `sort` is undocumented. If TR ever rejects it (it 400s an unrecognized
      // value) degrade to the documented oldest-first default rather than
      // letting a compliance backstop go dark: a window walk then reads
      // backwards (planTxrPageWalk); an owed-range walk wants oldest-first
      // anyway. Counted, so a permanent silent downgrade is still visible.
      const unsorted = await fetchMessages({ ...req, page: 0 });
      if (unsorted.ok) {
        res.sort_fallbacks++;
        sort = undefined;
        head = unsorted;
      }
    }
    if (!head.ok) {
      res.error = head.error;
      await notifyTelegram(
        `⚠️ Text Request messages poll FAILED (DLR reconcile backstop down)\n` +
          `error: ${head.error}\ncredential ${t.credential_id} · dashboard ${t.dashboard_id} (${label})`,
      ).catch(() => {});
      return stop("fetch_error");
    }

    // Forward pages when the API hands them in walk order (sorted, or an
    // owed-range walk on the oldest-first default); backwards otherwise.
    const forward = sort !== undefined || ascending;
    const plan = forward
      ? planTxrSortedWalk(head.totalItems, pageSize, maxPages)
      : planTxrPageWalk(head.totalItems, pageSize, maxPages);
    if (plan.truncated) {
      res.truncated = true;
      // Never a silent cap: say exactly what was skipped and why.
      const pagesTotal = Math.ceil(head.totalItems / pageSize);
      const which = ascending ? "Oldest pages were read; the newest" : "Newest pages were read; the oldest";
      const fate = stateful
        ? `${which} are owed and read on the next run.`
        : `${which} are left to the cron run (manual run).`;
      console.warn(
        `[textrequest-messages-poll] page cap hit — dashboard ${t.dashboard_id} (${label}, ${kind}): ` +
          `${head.totalItems} messages across ${pagesTotal} pages, reading ${maxPages}. ${fate}`,
      );
    }

    for (const page of plan.pages) {
      // Page 0's rows are already in hand from the head request — it is the
      // first page of any forward walk, and the only page of a one-page walk.
      const reuseHead = page === 0 && (forward || plan.pages.length === 1);
      if (!reuseHead && outOfTime()) return stop("budget");
      const pageRes = reuseHead ? head : await fetchMessages({ ...req, page, sort });
      if (!pageRes.ok) {
        // Stop the walk rather than skip the page: "everything past the last
        // row read is owed" only holds if no page in between was skipped.
        res.error = pageRes.error;
        console.warn(
          `[textrequest-messages-poll] page ${page} failed for dashboard ${t.dashboard_id}: ${pageRes.error}`,
        );
        return stop("fetch_error");
      }
      res.fetched += pageRes.items.length;

      // Inbound rows are the opt-out intake's business (Phase 4 signal 3a) — the
      // backstop for a lost or disconnected msg_received hook. Every run re-reads
      // the whole 6 h window, so most rows are already captured; at ~96 ms per
      // row (a transaction around a conflicting INSERT) that alone was ~37 s on
      // 2026-10-05 and ~145 s on 2026-09-10. ONE lookup per page skips the rows
      // already captured AND processed — for them the per-row path is a
      // conflicting insert that changes nothing, so the outcome is identical.
      // Anything else (new, or stored-but-unprocessed) goes through the per-row
      // path unchanged (scripts/verify-txr-inbound-prefilter.ts proves both).
      const inboundRows = pageRes.items.filter((m) => m.message_direction === "R");
      let known = new Set<string>();
      if (inboundRows.length > 0) {
        try {
          known = await txrProcessedInboundIds(database, t.provider_id, inboundRows.map((m) => m.message_id));
        } catch (e) {
          // A failed lookup just means no skipping: every row takes the per-row path.
          console.error("[textrequest-messages-poll] inbound lookup failed, processing every row:", e);
        }
      }
      for (const m of inboundRows) {
        res.inbound_seen++;
        if (known.has(m.message_id)) {
          res.inbound_dupe++;
          res.inbound_known++;
          continue;
        }
        try {
          const o = await processTxrInboundRow(database, t, m);
          if (o.kind === "dupe") res.inbound_dupe++;
          else {
            res.inbound_captured++;
            if (o.suppressed) res.inbound_suppressed++;
            if (o.breakerTrip) breakerTrips.push(o.breakerTrip);
          }
        } catch (e) {
          // Not counted as read: the page's range stays owed and is retried.
          console.error("[textrequest-messages-poll] inbound row failed, will retry next run:", e);
          return stop("write_error");
        }
      }

      const batch: TxrPollDlrBatchRow[] = [];
      for (const m of pageRes.items) {
        // Outbound rows carry the delivery facts the DLR backstop exists for.
        if (m.message_direction !== "S") continue;
        // A null delivery_status carries no DLR information AND would defeat the
        // poll's uniqueness key (NULLs are distinct in a Postgres unique index),
        // so it is skipped rather than captured.
        if (!m.delivery_status) continue;
        res.outbound_with_status++;
        batch.push({
          messageId: m.message_id,
          status: m.delivery_status.trim().toLowerCase(),
          // The list endpoint spells this `delivery_error`; the webhook spells
          // the same fact `errorCode`. Both land in error_code.
          errorCode: m.delivery_error ?? null,
          rawBody: JSON.stringify(m),
        });
      }
      if (batch.length > 0) {
        try {
          // One statement per page: capture + match (see captureTxrPollDlrBatch).
          // No ?ss= on this channel — the match is message_id ->
          // stage_sends.texthub_message_id.
          const b = await captureTxrPollDlrBatch(database, {
            orgId: t.org_id,
            credentialId: t.credential_id,
            providerId: t.provider_id,
            query: { dashboard_id: t.dashboard_id, start_date: w.start_date, end_date: w.end_date },
            rows: batch,
          });
          res.captured += b.captured;
          res.dupe += b.dupe;
          res.matched += b.matched;
          res.unmatched += b.unmatched;
        } catch (e) {
          // The page is NOT counted as read, so its range stays owed and is
          // retried — a failed write must not advance the walk past it.
          console.error("[textrequest-messages-poll] page write failed, will retry next run:", e);
          return stop("write_error");
        }
      }
      for (const m of pageRes.items) {
        const ts = parseTxrUtcTimestamp(m.message_timestamp_utc);
        if (!ts) continue;
        if (!oldestRead || ts < oldestRead) oldestRead = ts;
        if (!newestRead || ts > newestRead) newestRead = ts;
      }
      report.pages_read++;
    }
    if (plan.truncated) return stop("page_cap");
    report.complete = true;
    return { complete: true, oldestRead, newestRead };
  };

  // Inbound (the compliance side) before outbound when both are asked for.
  for (const direction of (["R", "S"] as const).filter((d) => directions.includes(d))) {
    const dashboards = [...new Set(targets.map((t) => t.dashboard_id))];
    const state = stateful
      ? await readStamps(database, [
          ...dashboards.map((d) => txrPassKey(d, direction)),
          ...dashboards.flatMap((d) => [gapFromKey(d, direction), gapToKey(d, direction)]),
        ])
      : new Map<string, Date>();
    const order = stateful ? txrWalkOrder(targets, state, direction) : targets;
    const budgetFor = (left: number) =>
      opts?.deadlineAt === undefined ? null : txrBudgetEnd(clock(), opts.deadlineAt, left);

    // What each dashboard owes after this run. Saved as it changes, so a run
    // killed later still keeps the progress already made.
    const owedNow = new Map<string, TxrRange | null>();
    const save = async (t: TxrPollTarget, owed: TxrRange | null) => {
      owedNow.set(t.dashboard_id, owed);
      if (!stateful) return;
      if (owed) {
        await writeStamp(database, gapFromKey(t.dashboard_id, direction), owed.from);
        await writeStamp(database, gapToKey(t.dashboard_id, direction), owed.to);
      } else {
        await deleteStamps(database, [gapFromKey(t.dashboard_id, direction), gapToKey(t.dashboard_id, direction)]);
        await writeStamp(database, txrPassKey(t.dashboard_id, direction), new Date());
      }
    };

    // Pass 1: every dashboard, oldest complete pass first — its owed range
    // (oldest-first), then its window (newest-first), on an equal share of the
    // time left.
    for (let i = 0; i < order.length; i++) {
      const t = order[i];
      const budgetEnd = budgetFor(order.length - i);
      const gFrom = state.get(gapFromKey(t.dashboard_id, direction));
      const gTo = state.get(gapToKey(t.dashboard_id, direction));
      const prior = gFrom && gTo ? { from: gFrom, to: gTo } : null;
      let gapAfter: TxrRange | null = null;
      if (prior) {
        const g = await walk(t, direction, { start_date: prior.from.toISOString(), end_date: prior.to.toISOString() }, "gap", budgetEnd);
        gapAfter = g.complete ? null : txrOwedAfterAscending(prior, g.newestRead);
      }
      const r = await walk(t, direction, window, "window", budgetEnd);
      const windowOwed = r.complete
        ? null
        : txrUnreadRange(new Date(window.start_date), new Date(window.end_date), r.oldestRead);
      await save(t, txrMergeOwed(prior, gapAfter, windowOwed));
    }

    // Pass 2+: time left before the deadline goes back to the dashboards that
    // still owe something (a dashboard that finished early used to hand its time
    // only to the dashboards AFTER it). Oldest-first again, so every pass moves
    // an owed start forward; stop when nothing is owed, time is up, or a pass
    // makes no progress.
    if (opts?.deadlineAt !== undefined) {
      for (let pass = 0; pass < 5; pass++) {
        const owing = order.filter((t) => owedNow.get(t.dashboard_id));
        if (owing.length === 0 || clock() >= opts.deadlineAt) break;
        let progressed = false;
        for (let i = 0; i < owing.length; i++) {
          const t = owing[i];
          const owed = owedNow.get(t.dashboard_id)!;
          const g = await walk(t, direction, { start_date: owed.from.toISOString(), end_date: owed.to.toISOString() }, "gap", budgetFor(owing.length - i));
          const after = g.complete ? null : txrOwedAfterAscending(owed, g.newestRead);
          if (!after || after.from > owed.from) progressed = true;
          await save(t, after);
        }
        if (!progressed) break;
      }
    }

    for (const t of order) {
      const owed = owedNow.get(t.dashboard_id);
      if (owed) res.owed.push({ dashboard_id: t.dashboard_id, direction, from: owed.from.toISOString(), to: owed.to.toISOString() });
    }
  }

  // Opt-out-rate breaker alerts fire AFTER their transactions committed (the
  // latch itself happened in-tx), best-effort — same ordering pollAhoiCdr uses.
  for (const trip of breakerTrips) {
    await notifyTelegram(optOutBreakerAlertText(trip.campaignId, null, trip.result)).catch(() => {});
  }

  return res;
}
