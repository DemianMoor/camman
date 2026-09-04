import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// Per-token hourly counters (ClickUp 869evpmbz, migration 0176).
//
// ⚠️ WHY NOT lib/api/rate-limit.ts. That limiter is an IN-MEMORY token bucket
// and its own header says why it cannot serve a contractual limit:
//   "In a serverless deployment this only enforces per-instance — Vercel
//    spreads requests across cold/warm instances so the effective rate is
//    instance_count * limit."
// A per-token 300/hour cannot be enforced that way at all. Shared state means
// the database. This file is lib/intake/rate-limit.ts applied to tokens; that
// one is live and measured, so the construction is copied rather than reinvented.
//
// ⚠️ THE GUARD IS ON THE `DO UPDATE`, NOT IN APPLICATION CODE. The obvious shape
// increments unconditionally and lets the caller compare afterwards. As a
// limiter that has a real defect: a client hammering while ALREADY over the
// limit keeps incrementing, so REJECTED REQUESTS BURN THE QUOTA and an agent
// with a retry loop locks itself out for the rest of the hour without ever
// getting an answer. With `WHERE count + 1 <= limit` on the DO UPDATE, a refusal
// touches nothing and RETURNING yields NO ROW.

/**
 * Requests per token per hour.
 *
 * A constant, not a column: the card says Owner-adjustable is fine and no UI is
 * wanted. Making it a column would put a migration between "this is too low" and
 * a fix; making it an env var would let preview and production silently
 * disagree about a number that appears in the docs handed to the worker.
 */
export const TOKEN_REQUESTS_PER_HOUR = 300;

/**
 * Denials in one hour from a single token before the burst alert fires.
 * Ten is "someone is probing blocked routes", not "a script has a typo".
 */
export const DENIAL_BURST_THRESHOLD = 10;

export type UsageWindow = "request" | "denied";

export interface LimitDecision {
  allowed: boolean;
  /** Count after this call, or the limit itself when refused. */
  count: number;
  limit: number;
  /** Seconds until the hour rolls over — the Retry-After value. */
  retryAfterSeconds: number;
}

/** Start of the UTC hour containing `now`. */
function hourStart(now: Date): Date {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

function secondsToNextHour(now: Date): number {
  const next = hourStart(now).getTime() + 3_600_000;
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Atomically consume one request from the token's hourly budget.
 *
 * ⚠️ The INSERT branch is NOT covered by the WHERE, so the first call of an hour
 * always succeeds. That is correct here — we consume exactly 1 per call, and the
 * limit is >= 1 — but it is the same footgun lib/intake/rate-limit.ts documents
 * for batch consumption. If this ever grows an `n` parameter, the caller must
 * reject n > limit BEFORE calling.
 */
export async function consumeTokenRequest(
  orgId: string,
  tokenId: string,
  limit: number = TOKEN_REQUESTS_PER_HOUR,
  now: Date = new Date(),
): Promise<LimitDecision> {
  const start = hourStart(now);
  const rows = (await db.execute(sql`
    INSERT INTO api_token_usage (org_id, api_token_id, window_kind, window_start, count)
    VALUES (${orgId}::uuid, ${tokenId}::uuid, 'request', ${start.toISOString()}::timestamptz, 1)
    ON CONFLICT (api_token_id, window_kind, window_start)
    DO UPDATE SET count = api_token_usage.count + 1
      WHERE api_token_usage.count + 1 <= ${limit}
    RETURNING count
  `)) as unknown as { count: number }[];

  const allowed = rows.length > 0;
  return {
    allowed,
    count: allowed ? Number(rows[0].count) : limit,
    limit,
    retryAfterSeconds: secondsToNextHour(now),
  };
}

/**
 * Record one denial against a token.
 *
 * UNCONDITIONAL increment — this is a counter, not a gate, and it must keep
 * counting past the alert threshold so the burst alert can report the real
 * figure instead of restating its own threshold.
 *
 * Returns the running count for this hour so the caller can decide whether this
 * call is the one that crosses DENIAL_BURST_THRESHOLD.
 */
export async function recordTokenDenial(
  orgId: string,
  tokenId: string,
  now: Date = new Date(),
): Promise<number> {
  const start = hourStart(now);
  const rows = (await db.execute(sql`
    INSERT INTO api_token_usage (org_id, api_token_id, window_kind, window_start, count)
    VALUES (${orgId}::uuid, ${tokenId}::uuid, 'denied', ${start.toISOString()}::timestamptz, 1)
    ON CONFLICT (api_token_id, window_kind, window_start)
    DO UPDATE SET count = api_token_usage.count + 1
    RETURNING count
  `)) as unknown as { count: number }[];
  return Number(rows[0]?.count ?? 0);
}
