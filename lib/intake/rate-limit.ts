import { sql } from "drizzle-orm";

import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import type { DbOrTx } from "./partner-key";

// DB-backed per-partner rate limiting — Drip Phase 2.
//
// ⚠️ WHY NOT lib/api/rate-limit.ts. That limiter is an IN-MEMORY token bucket
// and its own header says why it cannot serve a contractual limit:
//   "In a serverless deployment this only enforces per-instance — Vercel
//    spreads requests across cold/warm instances so the effective rate is
//    instance_count * limit."
// A per-partner 10 req/s cannot be enforced that way at all. Shared state means
// the database.
//
// ⚠️ THE GUARD IS ON THE `DO UPDATE`, NOT IN APPLICATION CODE. The obvious
// shape — the one campaign_tracking_counters uses to allocate sequence numbers
// — increments unconditionally and lets the caller compare afterwards. As a
// limiter that has a real defect: a client hammering while ALREADY over the
// limit keeps incrementing, so REJECTED REQUESTS BURN THE QUOTA and a partner
// with a bad retry loop locks itself out for the rest of the ET day without
// ever delivering a lead. With `WHERE count + n <= limit` on the DO UPDATE, a
// refusal touches nothing and RETURNING yields NO ROW.
//
// Measured against production (rolled back): allow path 23.50 ms/op against a
// 24.1 ms bare round trip — the DB work is within noise of an empty query, so
// the cost is one network hop (~2 ms from fra1). Refuse path returned 0 rows
// and left the counter unchanged.
//
// ⚠️ UNITS DIFFER BY WINDOW (ruling G14):
//   'sec' counts REQUESTS — a 500-lead batch is one request
//   'day' counts LEADS    — a 500-lead batch costs 500
// Conflating them would make "50,000/day" mean 50,000 batches.

export type LimitWindow = "sec" | "day";

export interface LimitDecision {
  allowed: boolean;
  /** Count after this call, or the limit itself when refused. */
  count: number;
  window: LimitWindow;
  limit: number;
  /** Seconds until the window rolls over — the Retry-After value. */
  retryAfterSeconds: number;
}

function windowStart(window: LimitWindow, now: Date): Date {
  if (window === "sec") return new Date(Math.floor(now.getTime() / 1000) * 1000);
  // ET calendar day, not UTC and not a rolling 24h — the same day boundary
  // every other campaign-facing counter in the project uses.
  return campaignDayBoundsUtc(now).start;
}

function retryAfter(window: LimitWindow, now: Date): number {
  if (window === "sec") return 1;
  const end = campaignDayBoundsUtc(now).end.getTime();
  return Math.max(1, Math.ceil((end - now.getTime()) / 1000));
}

/**
 * Atomically consume `n` units from one window.
 *
 * ⚠️ The INSERT branch is NOT covered by the WHERE — the first call of a window
 * inserts `n` unguarded, so an oversized batch would be admitted once per
 * window. The caller MUST reject a batch larger than the daily limit before
 * calling this (see the 413 path in the route). That is asserted in
 * scripts/test-intake-schema.ts so this note cannot quietly become false.
 */
export async function consume(
  dbc: DbOrTx,
  {
    orgId,
    partnerKeyId,
    window,
    limit,
    n = 1,
    now = new Date(),
  }: {
    orgId: string;
    partnerKeyId: number;
    window: LimitWindow;
    limit: number;
    n?: number;
    now?: Date;
  },
): Promise<LimitDecision> {
  const start = windowStart(window, now);
  const rows = (await dbc.execute(sql`
    INSERT INTO partner_key_usage (org_id, partner_key_id, window_kind, window_start, count)
    VALUES (${orgId}::uuid, ${partnerKeyId}, ${window}, ${start.toISOString()}::timestamptz, ${n})
    ON CONFLICT (partner_key_id, window_kind, window_start)
    DO UPDATE SET count = partner_key_usage.count + ${n}
      WHERE partner_key_usage.count + ${n} <= ${limit}
    RETURNING count
  `)) as unknown as { count: number }[];

  const allowed = rows.length > 0;
  return {
    allowed,
    count: allowed ? Number(rows[0].count) : limit,
    window,
    limit,
    retryAfterSeconds: retryAfter(window, now),
  };
}

/**
 * Record a failed secret check against a resolved token.
 *
 * Unconditional increment — this is a counter, not a gate, and it must keep
 * counting past any threshold so the alert can report the real figure. Only
 * RESOLVED tokens land here: an unresolved token is a scanner and must never be
 * able to write rows (ruling G18).
 */
export async function recordAuthFailure(
  dbc: DbOrTx,
  { orgId, partnerKeyId, now = new Date() }: { orgId: string; partnerKeyId: number; now?: Date },
): Promise<number> {
  const start = campaignDayBoundsUtc(now).start;
  const rows = (await dbc.execute(sql`
    INSERT INTO partner_key_usage (org_id, partner_key_id, window_kind, window_start, count)
    VALUES (${orgId}::uuid, ${partnerKeyId}, 'auth_fail', ${start.toISOString()}::timestamptz, 1)
    ON CONFLICT (partner_key_id, window_kind, window_start)
    DO UPDATE SET count = partner_key_usage.count + 1
    RETURNING count
  `)) as unknown as { count: number }[];
  return Number(rows[0]?.count ?? 0);
}
