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
// misbehaves. Hitting it is reported (result.truncated + a Telegram alert),
// never silent.
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
  sort?: "desc";
}) => Promise<TxrMessagesPage>;

async function realFetchTxrMessages(opts: {
  apiKey: string;
  dashboardId: string;
  window: TxrMessagesWindow;
  page: number;
  pageSize: number;
  direction?: "S" | "R";
  sort?: "desc";
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
  inbound_suppressed: number; // resulted in a real opt-out
  truncated: boolean; // a page cap bit somewhere
  sort_fallbacks: number; // walks that had to drop `sort=desc` and read oldest-first
  error: string | null;
  /** Every walk this run made, with how far it got. */
  walks: TxrPollWalkReport[];
  /** Outbound ranges left owed after this run (read first on the next run). */
  outbound_gaps: { dashboard_id: string; from: string; to: string }[];
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
//   textrequest-poll:pass:<dashboard>:<R|S>  last time a walk of that dashboard
//                                            and direction read EVERYTHING it
//                                            was owed (alerts: textrequest-poll-health.ts)
//   textrequest-poll:gap-from:<dashboard>    an outbound range a run was owed but
//   textrequest-poll:gap-to:<dashboard>      did not finish reading (time budget,
//                                            page cap or a failed page). Read
//                                            FIRST on the next run, until empty.
//
// ⚠️ WHY THE GAP EXISTS. Each outbound walk now gets a time budget so one busy
// dashboard cannot starve the others (on 2026-10-05 dashboard 68093 used the
// whole 60 s every run and 68804 was never reached). A budget means a walk can
// stop early — and before this, a walk that stopped early simply lost its oldest
// pages: the next run starts from the newest again, and after 6 h those
// messages leave the window for good. Recording the unread range and reading it
// first next time means a cut-short walk is LATE, never lossy. Text Request
// serves the full message history (verified 2026-10-06 back to the first send),
// so an old gap is still readable.

export function txrPassKey(dashboardId: string, direction: "R" | "S"): string {
  return `textrequest-poll:pass:${dashboardId}:${direction}`;
}
const gapFromKey = (d: string) => `textrequest-poll:gap-from:${d}`;
const gapToKey = (d: string) => `textrequest-poll:gap-to:${d}`;

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

/** One span covering every unread range (the middle may be re-read; dedup makes that free). Pure. */
export function txrMergeRanges(ranges: TxrRange[]): TxrRange | null {
  if (ranges.length === 0) return null;
  return {
    from: new Date(Math.min(...ranges.map((r) => r.from.getTime()))),
    to: new Date(Math.max(...ranges.map((r) => r.to.getTime()))),
  };
}

/**
 * Outbound walk order: the dashboard whose last COMPLETE pass is oldest goes
 * first; never-completed dashboards before all of them. Ties keep input order.
 * Pure.
 */
export function txrOutboundOrder<T extends { dashboard_id: string }>(
  targets: T[],
  lastPass: Map<string, Date>,
): T[] {
  return targets
    .map((t, i) => ({ t, i, at: lastPass.get(txrPassKey(t.dashboard_id, "S"))?.getTime() ?? -Infinity }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.t);
}

/**
 * The time a dashboard's outbound walks may run until: an equal share of what is
 * left before the deadline, split over the dashboards not yet walked. A
 * dashboard that finishes early hands its unused time to the ones after it.
 * Pure.
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

export async function pollTxrMessages(
  database: typeof db,
  opts?: {
    orgId?: string;
    fetchMessages?: TxrMessagesFetcher;
    now?: Date;
    lookbackHours?: number;
    pageSize?: number;
    maxPages?: number;
    /** Which walks to run. The cron runs inbound first, then the contacts poll
     *  and webhook health, then outbound with the time that is left. Default both. */
    directions?: ("R" | "S")[];
    /** Epoch ms. Outbound pages are not started past it (split per dashboard).
     *  Omitted (manual trigger, tests) ⇒ no budget. Inbound is never budgeted. */
    deadlineAt?: number;
    /** Injectable clock for the budget, so tests need not sleep. */
    clock?: () => number;
  },
): Promise<TxrMessagesPollResult> {
  const fetchMessages = opts?.fetchMessages ?? realFetchTxrMessages;
  const pageSize = opts?.pageSize ?? PAGE_SIZE;
  const maxPages = opts?.maxPages ?? MAX_PAGES;
  const clock = opts?.clock ?? Date.now;
  const directions = opts?.directions ?? ["R", "S"];
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
    inbound_suppressed: 0,
    truncated: false,
    sort_fallbacks: 0,
    error: null,
    walks: [],
    outbound_gaps: [],
  };
  const breakerTrips: { campaignId: number; result: OptOutRateCheckResult }[] = [];
  const dashboardsSeen = new Set<string>();

  // Inbound rows are the opt-out intake's business (Phase 4 signal 3a) — the
  // backstop for a lost or disconnected msg_received hook. They go to
  // textrequest_inbound_events, never the DLR table, and stay ONE TRANSACTION
  // PER ROW: each can trip the opt-out-rate breaker, volume is small, and this
  // is the compliance path — it is not what timed out.
  const handleInbound = async (t: TxrPollTarget, m: TxrMessageRow) => {
    res.inbound_seen++;
    try {
      const outcome = await database.transaction(async (tx) => {
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
        if (!captured) return { kind: "dupe" as const };
        const r = await processTextrequestOptOut(tx, {
          eventId: captured.id,
          orgId: t.org_id,
          sourceNumber: m.customer_phone,
          message: m.body,
          channel: "poll_messages",
          receivedAt: parseTxrUtcTimestamp(m.message_timestamp_utc) ?? new Date(),
        });
        return { kind: "new" as const, res: r };
      });
      if (outcome.kind === "dupe") res.inbound_dupe++;
      else {
        res.inbound_captured++;
        if (outcome.res.kind === "suppressed") {
          res.inbound_suppressed++;
          if (outcome.res.breakerTrip) breakerTrips.push(outcome.res.breakerTrip);
        }
      }
    } catch (e) {
      console.error("[textrequest-messages-poll] inbound row failed, will retry next tick:", e);
    }
  };

  // One walk of one (dashboard, direction) over [w.start_date, w.end_date],
  // newest-first. Returns whether everything was read and, if not, the oldest
  // row it did read (txrUnreadRange turns that into the owed range).
  const walk = async (
    t: TxrPollTarget,
    direction: "R" | "S",
    w: TxrMessagesWindow,
    kind: "window" | "gap",
    budgetEnd: number | null,
  ): Promise<{ complete: boolean; oldestRead: Date | null }> => {
    if (!dashboardsSeen.has(t.dashboard_id)) {
      dashboardsSeen.add(t.dashboard_id);
      res.dashboards_polled++;
    }
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
    if (outOfTime()) {
      report.stopped = "budget";
      return { complete: false, oldestRead };
    }

    const label = direction === "S" ? "outbound" : "inbound";
    const req = { apiKey: t.api_key, dashboardId: t.dashboard_id, window: w, pageSize, direction };

    // Ask for newest-first explicitly instead of relying on TR's default order,
    // so page 0 is the newest page whatever meta.total_items says. Page 0
    // doubles as the head request that sizes the walk.
    let sort: "desc" | undefined = "desc";
    let head = await fetchMessages({ ...req, page: 0, sort });
    if (!head.ok) {
      // `sort` is undocumented. If TR ever rejects it (it 400s an unrecognized
      // value) degrade to the documented oldest-first order and the backwards
      // walk rather than letting a compliance backstop go dark. Counted, so a
      // permanent silent downgrade is still visible in the cron response.
      const unsorted = await fetchMessages({ ...req, page: 0 });
      if (unsorted.ok) {
        res.sort_fallbacks++;
        sort = undefined;
        head = unsorted;
      }
    }
    if (!head.ok) {
      res.error = head.error;
      report.stopped = "fetch_error";
      await notifyTelegram(
        `⚠️ Text Request messages poll FAILED (DLR reconcile backstop down)\n` +
          `error: ${head.error}\ncredential ${t.credential_id} · dashboard ${t.dashboard_id} (${label})`,
      ).catch(() => {});
      return { complete: false, oldestRead };
    }

    const plan = sort
      ? planTxrSortedWalk(head.totalItems, pageSize, maxPages)
      : planTxrPageWalk(head.totalItems, pageSize, maxPages);
    if (plan.truncated) {
      res.truncated = true;
      // Never a silent cap: say exactly what was skipped and why.
      const pagesTotal = Math.ceil(head.totalItems / pageSize);
      const fate =
        direction === "S"
          ? "Oldest pages are recorded as a backlog and read first on the next run."
          : "Oldest pages skipped (already covered by earlier ticks).";
      console.warn(
        `[textrequest-messages-poll] page cap hit — dashboard ${t.dashboard_id} (${label}, ${kind}): ` +
          `${head.totalItems} messages across ${pagesTotal} pages, reading the newest ${maxPages}. ${fate}`,
      );
      await notifyTelegram(
        `⚠️ Text Request messages poll hit its page cap\n` +
          `dashboard ${t.dashboard_id} (${label}, ${kind}): ${head.totalItems} messages ` +
          `(${pagesTotal} pages, cap ${maxPages}).\nNewest pages were read. ${fate}`,
      ).catch(() => {});
    }

    for (const page of plan.pages) {
      // Page 0's rows are already in hand from the head request — under
      // sort=desc it is the first page of the walk, so it is always reusable.
      const reuseHead = page === 0 && (sort || plan.pages.length === 1);
      if (!reuseHead && outOfTime()) {
        report.stopped = "budget";
        return { complete: false, oldestRead };
      }
      const pageRes = reuseHead ? head : await fetchMessages({ ...req, page, sort });
      if (!pageRes.ok) {
        // Stop the walk rather than skip the page: the walk reads newest-first,
        // and "everything older than the oldest row read is owed" only holds if
        // no page in between was skipped.
        res.error = pageRes.error;
        report.stopped = "fetch_error";
        console.warn(
          `[textrequest-messages-poll] page ${page} failed for dashboard ${t.dashboard_id}: ${pageRes.error}`,
        );
        return { complete: false, oldestRead };
      }
      res.fetched += pageRes.items.length;

      const batch: TxrPollDlrBatchRow[] = [];
      for (const m of pageRes.items) {
        if (m.message_direction === "R") {
          await handleInbound(t, m);
          continue;
        }
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
          report.stopped = "write_error";
          return { complete: false, oldestRead };
        }
      }
      for (const m of pageRes.items) {
        const ts = parseTxrUtcTimestamp(m.message_timestamp_utc);
        if (ts && (!oldestRead || ts < oldestRead)) oldestRead = ts;
      }
      report.pages_read++;
    }
    if (plan.truncated) {
      report.stopped = "page_cap";
      return { complete: false, oldestRead };
    }
    report.complete = true;
    return { complete: true, oldestRead };
  };

  // Inbound first, every dashboard, unbudgeted — the compliance side.
  if (directions.includes("R")) {
    for (const t of targets) {
      const r = await walk(t, "R", window, "window", null);
      if (r.complete) await writeStamp(database, txrPassKey(t.dashboard_id, "R"), new Date());
    }
  }

  if (directions.includes("S")) {
    const dashboards = [...new Set(targets.map((t) => t.dashboard_id))];
    const state = await readStamps(database, [
      ...dashboards.map((d) => txrPassKey(d, "S")),
      ...dashboards.flatMap((d) => [gapFromKey(d), gapToKey(d)]),
    ]);
    const order = txrOutboundOrder(targets, state);
    for (let i = 0; i < order.length; i++) {
      const t = order[i];
      const budgetEnd =
        opts?.deadlineAt === undefined ? null : txrBudgetEnd(clock(), opts.deadlineAt, order.length - i);
      const owed: TxrRange[] = [];
      const gFrom = state.get(gapFromKey(t.dashboard_id));
      const gTo = state.get(gapToKey(t.dashboard_id));
      if (gFrom && gTo) {
        const gw = { start_date: gFrom.toISOString(), end_date: gTo.toISOString() };
        const g = await walk(t, "S", gw, "gap", budgetEnd);
        if (!g.complete) owed.push(txrUnreadRange(gFrom, gTo, g.oldestRead));
      }
      const r = await walk(t, "S", window, "window", budgetEnd);
      if (!r.complete) {
        owed.push(txrUnreadRange(new Date(window.start_date), new Date(window.end_date), r.oldestRead));
      }
      const gap = txrMergeRanges(owed);
      if (gap) {
        await writeStamp(database, gapFromKey(t.dashboard_id), gap.from);
        await writeStamp(database, gapToKey(t.dashboard_id), gap.to);
        res.outbound_gaps.push({
          dashboard_id: t.dashboard_id,
          from: gap.from.toISOString(),
          to: gap.to.toISOString(),
        });
      } else {
        await deleteStamps(database, [gapFromKey(t.dashboard_id), gapToKey(t.dashboard_id)]);
        await writeStamp(database, txrPassKey(t.dashboard_id, "S"), new Date());
      }
    }
  }

  // Opt-out-rate breaker alerts fire AFTER their transactions committed (the
  // latch itself happened in-tx), best-effort — same ordering pollAhoiCdr uses.
  for (const trip of breakerTrips) {
    await notifyTelegram(optOutBreakerAlertText(trip.campaignId, null, trip.result)).catch(() => {});
  }

  return res;
}
