import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { optOutBreakerAlertText, type OptOutRateCheckResult } from "@/lib/sends/optout-rate-breaker";
import { textrequestBaseUrl, textrequestPhoneToE164 } from "@/lib/sends/providers/textrequest";
import {
  parseTxrUtcTimestamp,
  resolveTxrPollTargets,
} from "@/lib/sends/textrequest-messages-poll";
import { captureTxrInboundEvent, processTextrequestOptOut } from "@/lib/sends/textrequest-optout";

// Text Request contacts poll — opt-out signal 3b, the backstop for a lost or
// disconnected `contact_updated` hook. Reads
// GET /dashboards/{id}/contacts?has_opted_out=true and records any suppression
// we don't already have.
//
// BOUNDING THIS QUERY IS THE WHOLE DESIGN PROBLEM: `has_opted_out=true` returns
// EVERY contact that ever opted out, forever, and Text Request offers no
// opted-out-date filter and no ordering control. An unbounded sweep every 15
// minutes would re-read the entire suppression history of the account — which
// grows without limit — so the poll pairs it with `last_message_received_after`
// (verified honored in recon): a STOP is an inbound message, so a contact who
// just opted out by replying has a recent received-message timestamp. That keeps
// the result set proportional to RECENT activity rather than to all history.
//
// Documented consequence: a suppression created with NO inbound reply (an
// operator ticking "do not text" in the Text Request portal, or an opt-out older
// than the lookback) is NOT caught by this poll. The real-time `contact_updated`
// hook covers that case, and its health is checked every tick
// (checkTxrWebhookHealth). Both would have to be down for a portal-side
// suppression to be missed.
//
// Being processed a second time is harmless anyway: the processor's
// already-opted-out check makes a state-shaped signal act exactly once per
// number (see lib/sends/textrequest-optout.ts).

const DEFAULT_LOOKBACK_HOURS = 24;
const PAGE_SIZE = 500;
const MAX_PAGES = 20;

export interface TxrContactRow {
  phone_number: string | null;
  is_suppressed: boolean | null;
  is_blocked: boolean | null;
  suppressed_reason: string | null;
  opted_out_utc: string | null;
  last_msg_received_utc: string | null;
}

export type TxrContactsPage =
  | { ok: true; items: TxrContactRow[]; totalItems: number }
  | { ok: false; error: string };

export type TxrContactsFetcher = (opts: {
  apiKey: string;
  dashboardId: string;
  lastMessageReceivedAfter: string;
  page: number;
  pageSize: number;
}) => Promise<TxrContactsPage>;

async function realFetchTxrContacts(opts: {
  apiKey: string;
  dashboardId: string;
  lastMessageReceivedAfter: string;
  page: number;
  pageSize: number;
}): Promise<TxrContactsPage> {
  try {
    const u = new URL(`${textrequestBaseUrl()}/dashboards/${encodeURIComponent(opts.dashboardId)}/contacts`);
    u.searchParams.set("has_opted_out", "true");
    u.searchParams.set("last_message_received_after", opts.lastMessageReceivedAfter);
    u.searchParams.set("page", String(opts.page));
    u.searchParams.set("page_size", String(opts.pageSize));
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
    const items = Array.isArray(parsed.items) ? (parsed.items as TxrContactRow[]) : [];
    const meta = (parsed.meta ?? null) as { total_items?: number } | null;
    return { ok: true, items, totalItems: meta?.total_items ?? items.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
}

export interface TxrContactsPollResult {
  dashboards_polled: number;
  fetched: number;
  actionable: number; // rows asserting an opt-out
  already_recorded: number; // we already suppress that number — no row written
  captured: number;
  suppressed: number;
  invalid_phone: number;
  truncated: boolean;
  error: string | null;
}

export async function pollTxrOptedOutContacts(
  database: typeof db,
  opts?: {
    orgId?: string;
    fetchContacts?: TxrContactsFetcher;
    now?: Date;
    lookbackHours?: number;
    pageSize?: number;
    maxPages?: number;
  },
): Promise<TxrContactsPollResult> {
  const fetchContacts = opts?.fetchContacts ?? realFetchTxrContacts;
  const pageSize = opts?.pageSize ?? PAGE_SIZE;
  const maxPages = opts?.maxPages ?? MAX_PAGES;
  const now = opts?.now ?? new Date();
  const lastMessageReceivedAfter = new Date(
    now.getTime() - (opts?.lookbackHours ?? DEFAULT_LOOKBACK_HOURS) * 3600_000,
  ).toISOString();

  const targets = await resolveTxrPollTargets(database, { orgId: opts?.orgId });
  const res: TxrContactsPollResult = {
    dashboards_polled: 0,
    fetched: 0,
    actionable: 0,
    already_recorded: 0,
    captured: 0,
    suppressed: 0,
    invalid_phone: 0,
    truncated: false,
    error: null,
  };
  const trips: { campaignId: number; result: OptOutRateCheckResult }[] = [];

  for (const t of targets) {
    res.dashboards_polled++;
    for (let page = 0; page < maxPages; page++) {
      const pageRes = await fetchContacts({
        apiKey: t.api_key,
        dashboardId: t.dashboard_id,
        lastMessageReceivedAfter,
        page,
        pageSize,
      });
      if (!pageRes.ok) {
        res.error = pageRes.error;
        await notifyTelegram(
          `⚠️ Text Request contacts poll FAILED (opt-out backstop down)\n` +
            `error: ${pageRes.error}\ncredential ${t.credential_id} · dashboard ${t.dashboard_id}`,
        ).catch(() => {});
        break;
      }
      res.fetched += pageRes.items.length;

      for (const c of pageRes.items) {
        // `has_opted_out=true` is a server-side filter, but re-check locally:
        // a filter regression upstream must not turn this into a poll that
        // suppresses every contact on the dashboard.
        const asserted = !!c.opted_out_utc || c.is_suppressed === true;
        if (!asserted) continue;
        res.actionable++;

        const phone = textrequestPhoneToE164(c.phone_number);
        if (!phone) {
          res.invalid_phone++;
          continue;
        }

        try {
          // Check FIRST, capture second: a state-shaped signal is re-observed on
          // every tick, so writing an event row for a number we already suppress
          // would fill the table with no-ops. The processor would classify it
          // 'already_opted_out' anyway — this just avoids the row.
          const known = (await database.execute(sql`
            SELECT 1
            FROM opt_outs o
            JOIN contacts ct ON ct.id = o.contact_id
            WHERE o.org_id = ${t.org_id} AND ct.phone_number = ${phone}
            LIMIT 1
          `)) as unknown as unknown[];
          if (known.length > 0) {
            res.already_recorded++;
            continue;
          }

          const optedOutUtc = parseTxrUtcTimestamp(c.opted_out_utc);
          const receivedAt = optedOutUtc ?? now;
          const outcome = await database.transaction(async (tx) => {
            const captured = await captureTxrInboundEvent(tx, {
              orgId: t.org_id,
              credentialId: t.credential_id,
              providerId: t.provider_id,
              channel: "poll_contacts",
              method: "poll",
              sourceNumber: c.phone_number,
              destinationNumber: null,
              message: null,
              // Contact rows carry no message GUID; idempotency rests on the
              // already-recorded check above plus the processor's own.
              providerUuid: null,
              optedOutUtc,
              rawBody: JSON.stringify(c),
              receivedAt,
            });
            if (!captured) return null;
            return processTextrequestOptOut(tx, {
              eventId: captured.id,
              orgId: t.org_id,
              sourceNumber: c.phone_number,
              message: null,
              channel: "poll_contacts",
              receivedAt,
            });
          });
          if (!outcome) continue;
          res.captured++;
          if (outcome.kind === "suppressed") {
            res.suppressed++;
            if (outcome.breakerTrip) trips.push(outcome.breakerTrip);
          }
        } catch (e) {
          console.error("[textrequest-contacts-poll] row failed, will retry next tick:", e);
        }
      }

      // Last page reached (0-based paging over meta.total_items).
      if ((page + 1) * pageSize >= pageRes.totalItems) break;
      if (page === maxPages - 1) {
        res.truncated = true;
        console.warn(
          `[textrequest-contacts-poll] page cap hit — dashboard ${t.dashboard_id}: ` +
            `${pageRes.totalItems} opted-out contacts in the window, read ${maxPages * pageSize}. ` +
            `Remainder deferred to the next tick.`,
        );
      }
    }
  }

  for (const trip of trips) {
    await notifyTelegram(optOutBreakerAlertText(trip.campaignId, null, trip.result)).catch(() => {});
  }

  return res;
}
