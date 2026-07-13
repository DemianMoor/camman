import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL!;

// In dev, Next.js HMR re-evaluates this module on every code change, which would
// open a fresh postgres-js pool each time and quickly exhaust Supavisor's
// session-mode client cap (~15). Cache the connection on globalThis so we reuse
// the same pool across HMR reloads. In production this is harmless — globalThis
// is per-instance — but it keeps `max` honest.
const globalForDb = globalThis as unknown as {
  __pg?: ReturnType<typeof postgres>;
};

export const sql =
  globalForDb.__pg ??
  postgres(connectionString, {
    prepare: false,
    max: 5,
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
