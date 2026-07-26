import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL!;

// In dev, Next.js HMR re-evaluates this module on every code change, which would
// open a fresh postgres-js pool each time and quickly exhaust the pooler's client
// budget. Cache the connection on globalThis so we reuse the same pool across HMR
// reloads. In production this is harmless — globalThis is per-instance — but it
// keeps `max` honest. DO NOT REMOVE: without it HMR leaks a pool per reload and
// surfaces as EMAXCONNSESSION.
const globalForDb = globalThis as unknown as {
  __pg?: ReturnType<typeof postgres>;
};

export const sql =
  globalForDb.__pg ??
  postgres(connectionString, {
    prepare: false,
    // Raised 5 → 16 in step with the send drain's concurrency.
    //
    // WHY 5 WAS WRONG. The figure was sized against Supavisor's SESSION-mode
    // client cap (~15), but `DATABASE_URL` targets the TRANSACTION pooler
    // (:6543, prepare=false) — see CLAUDE.md §6. Transaction mode hands a server
    // connection back per-transaction and multiplexes many more client
    // connections than session mode allows, so the old ceiling no longer
    // applies. Meanwhile the scheduled drain runs up to GROUP_CONCURRENCY (8)
    // phone groups × STAGE_CONCURRENCY_PER_PHONE (3) = 24 drain workers, so a
    // `max` of 5 meant the drain queued on ITSELF: that self-contention is why
    // two phones measured only ~1.5× the throughput of one instead of ~2×.
    //
    // WHY 16 AND NOT 24. The workers are not statement-bound — most of their
    // wall-clock is provider HTTP and token-bucket waits, with roughly 2 DB
    // round-trips per ~1s slice — so `max` needs to cover the simultaneous
    // STATEMENT peak, not the worker count. 16 covers it with headroom while
    // keeping the per-instance footprint modest (many Vercel instances share the
    // pooler's client budget, and 13 other crons + web traffic use the same
    // pool). `idle_timeout: 20` still returns quiet slots promptly.
    max: 16,
    // Connection hygiene for transaction-pooler (Supavisor :6543) use:
    // - idle_timeout (s): return an idle client to the pooler after 20s so a
    //   warm-but-quiet serverless instance doesn't pin its 5 slots between
    //   invocations. The pooler multiplexes per-transaction, so holding idle
    //   client connections open buys nothing.
    // - connect_timeout (s): fail fast (10s) if the pooler is saturated rather
    //   than hanging the whole request until the platform kills it.
    // - max_lifetime (s): recycle a client every 30min so it never rides a
    //   stale server-side backend the pooler may have rotated underneath us.
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 60 * 30,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__pg = sql;
}

export const db = drizzle(sql);
