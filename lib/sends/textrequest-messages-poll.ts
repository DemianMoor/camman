import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { decryptCredentialKey } from "@/lib/sends/provider-credential";
import { optOutBreakerAlertText, type OptOutRateCheckResult } from "@/lib/sends/optout-rate-breaker";
import { captureTxrPollDlrEvent, reconcileTxrDlrEvent } from "@/lib/sends/textrequest-dlr";
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
// 500 was accepted live; TR documents no maximum. Bigger pages = fewer requests.
const PAGE_SIZE = 500;
// Hard ceiling on pages per (dashboard, tick). At PAGE_SIZE=500 this is 10K
// messages — far above a realistic 6-hour window for one sending number, and a
// backstop against an unbounded loop if `meta.total_items` ever misbehaves.
// Hitting it is reported (result.truncated + a Telegram alert), never silent.
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
}) => Promise<TxrMessagesPage>;

async function realFetchTxrMessages(opts: {
  apiKey: string;
  dashboardId: string;
  window: TxrMessagesWindow;
  page: number;
  pageSize: number;
  direction?: "S" | "R";
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

// Page order, and why it runs BACKWARDS: TR documents (and live confirms)
// "Messages will always be sorted from oldest to newest", with no honored sort
// parameter. Under a page cap, walking forward would keep the OLDEST messages
// and drop the NEWEST — backwards for a backstop, whose whole job is to catch
// what just happened. So we read page 0 for `meta.total_items`, then walk from
// the LAST page down. If the cap bites, what's dropped is the oldest slice of
// the window, which earlier ticks already covered.
//
// Rows can shift between requests if new messages arrive mid-walk (page
// boundaries move). That's accepted: capture is idempotent, windows overlap
// tick-to-tick, and a row missed once is picked up next tick.
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
  error: string | null;
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

export async function pollTxrMessages(
  database: typeof db,
  opts?: {
    orgId?: string;
    fetchMessages?: TxrMessagesFetcher;
    now?: Date;
    lookbackHours?: number;
    pageSize?: number;
    maxPages?: number;
  },
): Promise<TxrMessagesPollResult> {
  const fetchMessages = opts?.fetchMessages ?? realFetchTxrMessages;
  const pageSize = opts?.pageSize ?? PAGE_SIZE;
  const maxPages = opts?.maxPages ?? MAX_PAGES;
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
    error: null,
  };
  const breakerTrips: { campaignId: number; result: OptOutRateCheckResult }[] = [];

  for (const t of targets) {
    res.dashboards_polled++;

    // Page 0 first, purely to learn total_items for the backwards walk.
    const head = await fetchMessages({
      apiKey: t.api_key,
      dashboardId: t.dashboard_id,
      window,
      page: 0,
      pageSize,
    });
    if (!head.ok) {
      res.error = head.error;
      await notifyTelegram(
        `⚠️ Text Request messages poll FAILED (DLR reconcile backstop down)\n` +
          `error: ${head.error}\ncredential ${t.credential_id} · dashboard ${t.dashboard_id}`,
      ).catch(() => {});
      continue;
    }

    const walk = planTxrPageWalk(head.totalItems, pageSize, maxPages);
    if (walk.truncated) {
      res.truncated = true;
      // Never a silent cap: say exactly what was skipped and why.
      const pagesTotal = Math.ceil(head.totalItems / pageSize);
      console.warn(
        `[textrequest-messages-poll] page cap hit — dashboard ${t.dashboard_id}: ` +
          `${head.totalItems} messages across ${pagesTotal} pages, reading the newest ${maxPages}. ` +
          `Oldest ${pagesTotal - maxPages} page(s) skipped (already covered by earlier ticks).`,
      );
      await notifyTelegram(
        `⚠️ Text Request messages poll hit its page cap\n` +
          `dashboard ${t.dashboard_id}: ${head.totalItems} messages in the ${
            opts?.lookbackHours ?? DEFAULT_LOOKBACK_HOURS
          }h window (${pagesTotal} pages, cap ${maxPages}).\n` +
          `Newest pages were read; oldest skipped. Consider a shorter lookback or a higher cap.`,
      ).catch(() => {});
    }

    for (const page of walk.pages) {
      // Page 0's rows are already in hand from the head request.
      const pageRes =
        page === 0 && walk.pages.length === 1
          ? head
          : await fetchMessages({ apiKey: t.api_key, dashboardId: t.dashboard_id, window, page, pageSize });
      if (!pageRes.ok) {
        res.error = pageRes.error;
        console.warn(
          `[textrequest-messages-poll] page ${page} failed for dashboard ${t.dashboard_id}: ${pageRes.error}`,
        );
        continue;
      }
      res.fetched += pageRes.items.length;

      for (const m of pageRes.items) {
        // Inbound rows are the opt-out intake's business (Phase 4 signal 3a) —
        // the backstop for a lost or disconnected msg_received hook. They go to
        // textrequest_inbound_events, never the DLR table.
        if (m.message_direction === "R") {
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
          continue;
        }
        // Outbound rows carry the delivery facts the DLR backstop exists for.
        if (m.message_direction !== "S") continue;
        // A null delivery_status carries no DLR information AND would defeat the
        // poll's uniqueness key (NULLs are distinct in a Postgres unique index),
        // so it is skipped rather than captured — see captureTxrPollDlrEvent.
        if (!m.delivery_status) continue;
        res.outbound_with_status++;

        try {
          // Capture + reconcile atomically per row, mirroring pollAhoiCdr: if
          // reconcile throws, the capture rolls back too, so the same message is
          // naturally re-read and retried on the next tick.
          const outcome = await database.transaction(async (tx) => {
            const captured = await captureTxrPollDlrEvent(tx, {
              orgId: t.org_id,
              credentialId: t.credential_id,
              providerId: t.provider_id,
              method: "poll",
              query: { dashboard_id: t.dashboard_id, start_date: window.start_date, end_date: window.end_date },
              headers: {},
              rawBody: JSON.stringify(m),
              stageSendId: null,
              parsed: {
                messageId: m.message_id,
                status: m.delivery_status!.trim().toLowerCase(),
                // The list endpoint spells this `delivery_error`; the webhook
                // spells the same fact `errorCode`. Both land in error_code.
                errorCode: m.delivery_error ?? null,
              },
            });
            if (!captured) return { kind: "dupe" as const };
            // No ?ss= on this channel — reconcile falls back to
            // message_id -> stage_sends.texthub_message_id.
            const r = await reconcileTxrDlrEvent(tx, {
              eventId: captured.id,
              orgId: t.org_id,
              stageSendId: null,
              messageId: m.message_id,
            });
            return { kind: "new" as const, result: r.result };
          });
          if (outcome.kind === "dupe") res.dupe++;
          else {
            res.captured++;
            if (outcome.result === "matched") res.matched++;
            else res.unmatched++;
          }
        } catch (e) {
          console.error("[textrequest-messages-poll] row failed, will retry next tick:", e);
        }
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
