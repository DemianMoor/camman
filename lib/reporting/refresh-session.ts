import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// =============================================================================
// A SESSION-MODE CONNECTION FOR THE TWICE-DAILY REPORT MATVIEW REFRESH.
//
// Scoped to ONE caller: lib/reporting/offer-group-report.ts's
// refreshOfferGroupReport(), which /api/cron/refresh-offer-group-report calls.
// Nothing else should import this. It is not a general-purpose "big query"
// connection — it is a deliberate, measured exception for one background job.
//
// ── WHY A SEPARATE CONNECTION AT ALL ─────────────────────────────────────────
// The shared pool in db/client.ts points at Supabase's TRANSACTION pooler
// (Supavisor, port 6543), which multiplexes many clients onto few backends and
// hands a different backend out per transaction. Two consequences:
//
//   1. A bare `SET` there is worthless — it configures whichever backend
//      happened to serve that statement, and the next statement may land on
//      another one.
//   2. `SET LOCAL` is unavailable, because `REFRESH MATERIALIZED VIEW
//      CONCURRENTLY` cannot run inside a transaction block. That is the trick
//      lib/reporting/counted-clickers.ts (300s) and lib/reporting/epc-monitors.ts
//      (240s) use, and it is exactly the one this job cannot.
//
// Session mode (port 5432) pins one backend for the life of the client, so a
// plain `SET` sticks across the four autocommit REFRESH statements. Same host,
// same credentials — only the port differs. The connection is opened for this
// job and closed in a `finally`; it does not join the shared pool.
//
// ── WHY THE SETTINGS ARE RAISED (MEASURED 2026-09-21, PROD, READ-ONLY) ───────
// Prod's cluster default is statement_timeout = 120000ms and work_mem = 5120kB,
// both from `configuration file` (a Supabase platform default on every
// connection; pg_db_role_setting carries no override for the `postgres` role).
//
// The group matview's refresh took 107.5s on the real 05:00 UTC run — read back
// as the gap between consecutive report_refresh_log stamps, not estimated. That
// is 12.5s under the 120s wall, and a cancellation there is SQLSTATE 57014,
// which used to take the two views queued behind it down with it.
//
// Root cause is one sort node. At work_mem = 5120kB, EXPLAIN (ANALYZE) of the
// group view's defining SELECT on prod reports
//     Sort Method: external merge  Disk: 128368kB   (+ the parallel worker's)
// while the plan's other sorts are in-memory quicksorts of a few MB. Given room
// that same node becomes
//     Sort Method: quicksort  Memory: 236189kB      (+ 235517kB in worker 0)
// and every sort in the plan fits in memory.
// =============================================================================

/**
 * Ceiling for a single sort/hash node, for this job's connection only.
 *
 * WHY 384MB: the one sort that spills needs 236,189kB (231MB) resident, and it
 * runs in BOTH the leader and one parallel worker
 * (max_parallel_workers_per_gather = 1), so the real peak is ~460MB today.
 * 384MB is 1.63x the measured requirement — room for the underlying send/click
 * volume to grow ~60% before this regresses to a disk merge, rather than a
 * value that just scrapes past today's number and silently spills again next
 * quarter.
 *
 * WHAT IT COSTS IF THE JOB MISBEHAVES: work_mem is a per-node CEILING, not an
 * allocation — Postgres takes only what the data needs. But it is charged per
 * sort node and per parallel worker, so the worst case for this plan's big sort
 * is 384MB x 2 = 768MB. On this instance (shared_buffers 512MB,
 * effective_cache_size 1.5GB => ~2GB of RAM) that is survivable but not
 * trivial, which is why this is 384MB and not 512MB: 512 x 2 = 1GB would leave
 * too little behind shared_buffers. The exposure lasts only as long as the job
 * — roughly two minutes, twice a day — and no other connection sees it.
 */
export const REFRESH_WORK_MEM = "384MB";
const REFRESH_WORK_MEM_KB = 393216; // 384 * 1024, what pg_settings should read back

/**
 * Per-statement timeout for this job's connection only.
 *
 * WHY 180s: the group refresh costs 107.5s today, and the defining SELECT
 * measured 87.7-103.8s under the new work_mem on a QUIET production database.
 * 180s is ~1.7-2x that — room for a bad day without a 57014.
 *
 * It is not theoretical room. In a paired A/B on 2026-09-21, a third pair
 * landed while production was actually busy (1 and 4 other active backends):
 * the SAME query took 269.1s at the current work_mem and 163.1s at 384MB. So
 * this statement is ALREADY capable of exceeding the platform's 120s default
 * under load — today's 12.5s of headroom only holds on a quiet cluster.
 *
 * WHY NOT MORE, e.g. 240s: the four views share ONE Vercel invocation capped at
 * maxDuration = 300s, and the other three stretch under load too. Budgeting
 * group 180 + offer-totals ~90 + summary ~20 + audience ~3 = ~293s still fits;
 * at 240 the same bad day is ~353s and Vercel kills the invocation — which is
 * the one failure mode with NO catch and NO alert. Keeping the database's
 * cancellation (SQLSTATE 57014, which throws and alerts) strictly inside the
 * platform's is what keeps failure loud.
 *
 * AND IF 180s IS EXCEEDED ANYWAY, it is now contained rather than catastrophic:
 * the per-view catch means group's 57014 freezes group alone and the other
 * three still refresh and stamp. That is what makes 180 a balance rather than a
 * gamble. It also bounds a genuinely stuck refresh: one wedged statement holds
 * one session-pooler slot for at most three minutes, twice a day, instead of
 * running until the platform reaps it.
 */
export const REFRESH_STATEMENT_TIMEOUT = "180s";
const REFRESH_STATEMENT_TIMEOUT_MS = 180000;

/**
 * Supavisor exposes the SAME database on two ports: 6543 transaction-pooled,
 * 5432 session-pooled. Derive rather than adding an env var, so there is no
 * second connection string to set in Vercel, drift from DATABASE_URL, or fail
 * to rotate. A URL that is already session-mode or direct (port 5432) is passed
 * through untouched.
 *
 * `prepare=false` is a transaction-pooler workaround and is dropped here.
 */
export function toSessionModeUrl(raw: string): string {
  const url = new URL(raw);
  if (url.port === "6543") url.port = "5432";
  url.searchParams.delete("prepare");
  return url.toString();
}

/**
 * Opens a dedicated session-mode connection, applies this job's
 * statement_timeout and work_mem, PROVES both took effect, runs `fn`, and
 * closes the connection in a `finally` so it cannot leak whatever happens.
 *
 * The read-back is not ceremony. Every way this fix can fail quietly ends with
 * a connection that did NOT get the settings — a pooler that swallowed the
 * `SET`, a URL that stayed on port 6543 and handed the next statement to a
 * different backend, a role-level override. In all of those the refresh runs at
 * 5120kB/120s exactly as before and the only symptom is the failure this change
 * was meant to prevent. So the settings are read back out of pg_settings and a
 * mismatch throws BEFORE any refresh runs.
 */
export async function withRefreshSession<T>(
  fn: (db: PostgresJsDatabase) => Promise<T>,
): Promise<T> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");

  const client = postgres(toSessionModeUrl(raw), {
    prepare: false,
    // One backend, so the `SET`s below apply to every statement fn() runs.
    max: 1,
    connect_timeout: 15,
    // Never recycle mid-job: a reconnect would silently drop the settings.
    idle_timeout: 0,
    max_lifetime: 0,
  });

  try {
    const db = drizzle(client);

    // Constants defined in this module, never caller input — safe to inline,
    // and they have to be: SET does not accept bind parameters.
    await db.execute(sql.raw(`set statement_timeout = '${REFRESH_STATEMENT_TIMEOUT}'`));
    await db.execute(sql.raw(`set work_mem = '${REFRESH_WORK_MEM}'`));

    // Deliberately a SEPARATE statement from the SETs above: on a transaction
    // pooler this is where the lie shows up, because the read lands on a
    // different backend than the write did.
    const applied = (await db.execute(sql`
      select
        (select setting::bigint from pg_settings where name = 'work_mem') as work_mem_kb,
        (select setting::bigint from pg_settings where name = 'statement_timeout') as statement_timeout_ms
    `)) as unknown as { work_mem_kb: string | number; statement_timeout_ms: string | number }[];

    const workMemKb = Number(applied[0]?.work_mem_kb);
    const timeoutMs = Number(applied[0]?.statement_timeout_ms);
    if (workMemKb !== REFRESH_WORK_MEM_KB || timeoutMs !== REFRESH_STATEMENT_TIMEOUT_MS) {
      throw new Error(
        `refresh session settings did not stick: work_mem=${workMemKb}kB ` +
          `(expected ${REFRESH_WORK_MEM_KB}kB), statement_timeout=${timeoutMs}ms ` +
          `(expected ${REFRESH_STATEMENT_TIMEOUT_MS}ms). Refusing to refresh — the ` +
          `connection is not session-mode, or an override outranks these settings.`,
      );
    }

    return await fn(db);
  } finally {
    // Closes even when fn() throws, when the settings guard throws, and when
    // the caller is cancelled: this connection must never outlive the job.
    await client.end({ timeout: 5 }).catch(() => {});
  }
}
