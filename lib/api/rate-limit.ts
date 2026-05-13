import "server-only";

// In-memory token bucket. Per-user, per-key.
// TODO: swap for a Redis-backed limiter once we have a shared-state cache.
// In a serverless deployment this only enforces per-instance — Vercel
// spreads requests across cold/warm instances so the effective rate is
// instance_count * limit. Tolerable for now (operator+ only, manual UI
// driver), but real protection requires shared state.

type Bucket = { tokens: number; lastRefillMs: number };

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  // Identifier for the caller (e.g. `${userId}:${endpoint}`).
  key: string;
  // Max tokens (= burst size = requests per window).
  capacity: number;
  // Tokens added per second.
  refillPerSecond: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export function consume(opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  let b = buckets.get(opts.key);
  if (!b) {
    b = { tokens: opts.capacity, lastRefillMs: now };
    buckets.set(opts.key, b);
  }
  // Refill since last seen.
  const elapsedSec = (now - b.lastRefillMs) / 1000;
  b.tokens = Math.min(opts.capacity, b.tokens + elapsedSec * opts.refillPerSecond);
  b.lastRefillMs = now;

  if (b.tokens >= 1) {
    b.tokens -= 1;
    return {
      allowed: true,
      remaining: Math.floor(b.tokens),
      retryAfterMs: 0,
    };
  }
  const needed = 1 - b.tokens;
  const retryAfterMs = Math.ceil((needed / opts.refillPerSecond) * 1000);
  return { allowed: false, remaining: 0, retryAfterMs };
}
