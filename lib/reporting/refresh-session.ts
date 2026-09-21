import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";

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

/** Which connection actually ran the refreshes, and what was actually in force on it. */
export type RefreshConnection = {
  /** `session` = the dedicated :5432 connection. `pooled` = the shared :6543 fallback. */
  mode: "session" | "pooled";
  /**
   * EFFECTIVE settings, read out of `pg_settings` ON THE CONNECTION THAT RAN
   * THE REFRESHES — not the values this module intended. When `mode` is
   * `pooled` these are the cluster defaults (5120kB / 120000ms), which is the
   * point: they say the fix was not in force.
   */
  workMemKb: number;
  statementTimeoutMs: number;
  /** Why the session connection was not used. Set only when `mode === "pooled"`. */
  fallbackReason?: string;
};

/**
 * The Tier-2 alert fired when the refresh falls back to the pooled connection.
 *
 * A separate pure function so it can be asserted verbatim in a test WITHOUT
 * sending anything to the real Telegram chat.
 */
export function fallbackAlertText(connection: RefreshConnection): string {
  return [
    "🟠 Tier-2 reports: offer-group-report matview refresh FELL BACK to the pooled connection — THE HEADROOM FIX IS INACTIVE.",
    `Session-mode connection unavailable: ${connection.fallbackReason ?? "unknown"}`,
    `This run refreshed WITHOUT the raised settings — effective work_mem=${connection.workMemKb}kB ` +
      `(intended ${REFRESH_WORK_MEM}), statement_timeout=${connection.statementTimeoutMs}ms ` +
      `(intended ${REFRESH_STATEMENT_TIMEOUT}).`,
    "offer_group_report_mv measured 107.5s against that 120000ms limit, so this run is back on the ~12.5s cliff and can be cancelled mid-refresh (SQLSTATE 57014).",
    "Every run stays unprotected until session-pooler connectivity (port 5432) is fixed.",
  ].join("\n");
}

/** Reads what is ACTUALLY in force, as its own statement. */
async function readEffectiveSettings(
  on: PostgresJsDatabase,
): Promise<{ workMemKb: number; statementTimeoutMs: number }> {
  const rows = (await on.execute(sql`
    select
      (select setting::bigint from pg_settings where name = 'work_mem') as work_mem_kb,
      (select setting::bigint from pg_settings where name = 'statement_timeout') as statement_timeout_ms
  `)) as unknown as { work_mem_kb: string | number; statement_timeout_ms: string | number }[];
  return {
    workMemKb: Number(rows[0]?.work_mem_kb),
    statementTimeoutMs: Number(rows[0]?.statement_timeout_ms),
  };
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
 * mismatch is treated exactly like a connection failure.
 *
 * ── FALLBACK: LOUD, NEVER SILENT ─────────────────────────────────────────────
 * NOTHING IN THIS APP HAS EVER CONNECTED VIA THE SESSION POOLER FROM VERCEL, so
 * the first unattended cron run is the first real test of port 5432 from that
 * network. If it fails, refusing to refresh would make this change WORSE than
 * what it replaced: four stale reports instead of a working-but-fragile job. So
 * `fn` is run on the shared pooled connection instead and the views refresh.
 *
 * But a silent fallback would be the worst outcome of all — it would look fixed
 * and behave exactly as before. So the fallback:
 *   1. fires a Tier-2 Telegram alert (the same `notifyTelegram` the rest of the
 *      codebase uses) saying in plain words that the fix is inactive and the job
 *      is back on the 120s cliff, and
 *   2. reports `mode: "pooled"` plus the settings ACTUALLY in force, which the
 *      route puts in its response and its log line.
 * There is no path that falls back without doing both.
 *
 * @param notify injectable only so tests can assert the alert text without
 *               sending to the real chat. Production always uses the default.
 */
export async function withRefreshSession<T>(
  fn: (db: PostgresJsDatabase, connection: RefreshConnection) => Promise<T>,
  notify: (text: string) => Promise<unknown> = notifyTelegram,
): Promise<T> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");

  let client: ReturnType<typeof postgres> | null = null;
  let sessionDb: PostgresJsDatabase | null = null;
  let connection: RefreshConnection | null = null;
  let fallbackReason: string | null = null;

  try {
    client = postgres(toSessionModeUrl(raw), {
      prepare: false,
      // One backend, so the `SET`s below apply to every statement fn() runs.
      max: 1,
      connect_timeout: 15,
      // Never recycle mid-job: a reconnect would silently drop the settings.
      idle_timeout: 0,
      max_lifetime: 0,
    });
    const candidate = drizzle(client);

    // Constants defined in this module, never caller input — safe to inline,
    // and they have to be: SET does not accept bind parameters.
    await candidate.execute(sql.raw(`set statement_timeout = '${REFRESH_STATEMENT_TIMEOUT}'`));
    await candidate.execute(sql.raw(`set work_mem = '${REFRESH_WORK_MEM}'`));

    // Deliberately a SEPARATE statement from the SETs above: on a transaction
    // pooler this is where the lie shows up, because the read lands on a
    // different backend than the write did.
    const applied = await readEffectiveSettings(candidate);
    if (
      applied.workMemKb !== REFRESH_WORK_MEM_KB ||
      applied.statementTimeoutMs !== REFRESH_STATEMENT_TIMEOUT_MS
    ) {
      throw new Error(
        `settings did not stick: work_mem=${applied.workMemKb}kB ` +
          `(expected ${REFRESH_WORK_MEM_KB}kB), statement_timeout=${applied.statementTimeoutMs}ms ` +
          `(expected ${REFRESH_STATEMENT_TIMEOUT_MS}ms) — the connection is not ` +
          `session-mode, or an override outranks these settings`,
      );
    }

    sessionDb = candidate;
    connection = { mode: "session", ...applied };
  } catch (err) {
    // Covers BOTH failure modes — could not connect, and connected but the
    // settings did not stick. Either way the raised settings are not in force,
    // so both take the loud fallback rather than one throwing and one not.
    fallbackReason = err instanceof Error ? err.message : String(err);
    if (client) await client.end({ timeout: 5 }).catch(() => {});
    client = null;
  }

  if (sessionDb && client && connection) {
    try {
      return await fn(sessionDb, connection);
    } finally {
      // Closes even when fn() throws and when the caller is cancelled: this
      // connection must never outlive the job.
      await client.end({ timeout: 5 }).catch(() => {});
    }
  }

  // ── FALLBACK PATH ──────────────────────────────────────────────────────────
  // Read the effective settings from the POOLED connection too, so the alert
  // and the response quote what was really in force rather than assuming the
  // cluster defaults. (The transaction pooler may answer this read from a
  // different backend than the refreshes use, but these are `configuration
  // file` defaults identical on every backend, so the reading is honest.)
  let effective = { workMemKb: NaN, statementTimeoutMs: NaN };
  try {
    effective = await readEffectiveSettings(db);
  } catch {
    // Never let the diagnostic read stop the refresh it is describing.
  }
  const pooled: RefreshConnection = {
    mode: "pooled",
    ...effective,
    fallbackReason: fallbackReason ?? "unknown",
  };

  console.error(
    `[refresh-offer-group-report] SESSION CONNECTION UNAVAILABLE — falling back to the ` +
      `pooled connection. The headroom fix is INACTIVE for this run. ` +
      `effectiveWorkMemKb=${pooled.workMemKb} effectiveStatementTimeoutMs=${pooled.statementTimeoutMs} ` +
      `reason=${pooled.fallbackReason}`,
  );
  // Awaited so delivery happens before the serverless invocation can end, and
  // BEFORE the refreshes run — a 180s refresh must not delay the warning, and
  // if the invocation is killed mid-refresh the alert has already gone.
  await notify(fallbackAlertText(pooled));

  return await fn(db, pooled);
}
