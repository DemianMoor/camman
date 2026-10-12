import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { appOrigin } from "@/lib/app-origin";
import { withCronLease, type CronLeaseOutcome } from "@/lib/cron/lease";

// The drip POKE CHAIN (lead-to-send speed-up, migration 0206). Ships dark.
//
// Every pipeline step used to wait for its own cron tick, and Vercel fires those
// at fixed seconds (lookup :05 on even minutes, routing :05, enrichment :18,
// scheduler :50, send drain :34 every 5 min). The work is seconds; the waits
// stacked to ~6 minutes. With org_settings.drip_poke_enabled on, a step that
// finished with work for the next one wakes it:
//
//   intake → lead-enrichment ⇄ lookup-worker
//                lead-enrichment → drip-routing → drip-scheduler → drip-drain
//
// ⭐ THE CRONS ARE THE SAFETY NET AND DO NOT CHANGE. A poke is an extra trigger
// for the SAME lease-wrapped function the cron runs: same lease key, same
// evaluator, same mint, same gates. A lost or failed poke changes nothing but
// latency — the next cron tick does the work exactly as it does today. No step
// depends on being poked.
//
// ⭐ NO NEW CONCURRENCY. A poked run takes the job's existing cron_locks lease,
// so at most ONE run of a step exists at any moment — the invariant the crons
// already have. A poke that finds the lease held does not run; it records
// poke_requested_at and the holder runs again before releasing.
//
// ⭐ COALESCING (no amplification in a burst). Per job:
//   * at most ONE wake-up request is in flight (poke_dispatched_at);
//   * runs are spaced at least POKE_MIN_GAP_MS apart (last_run_started_at);
//   * the holder's re-runs stay inside the route's time budget.
// So a step runs at most ~60/5 = 12 times a minute, one at a time, however many
// leads arrive.
//
// ⭐ DRAIN POKES ARE DRIP-ONLY. A poked drain runs runScheduledSends with
// dripOnly: no Phase A, no regular stage — so a regular campaign's per-run
// budget (max_sends_per_run) and send rate are exactly as before.
// See docs/04-features/drip-poke-chain.md.

export type PokeJob =
  | "lead-enrichment"
  | "lookup-worker"
  | "drip-routing"
  | "drip-scheduler"
  | "drip-drain";

export type PokeTrigger = "cron" | "poke";

const ROUTE: Record<PokeJob, string> = {
  "lead-enrichment": "/api/cron/lead-enrichment",
  "lookup-worker": "/api/cron/lookup-worker",
  "drip-routing": "/api/cron/drip-routing",
  "drip-scheduler": "/api/cron/drip-scheduler",
  "drip-drain": "/api/cron/send-scheduled",
};

/** Marks a request as a poke (with the CRON_SECRET bearer). */
export const POKE_HEADER = "x-camman-poke";
/** Minimum spacing between two runs of one job while pokes are on. */
export const POKE_MIN_GAP_MS = 5_000;
/** The flag is read at most this often per instance — "off" lands within it. */
const FLAG_CACHE_MS = 5_000;
/** The poked route answers 202 before it works, so this only covers delivery. */
const DISPATCH_TIMEOUT_MS = 10_000;

let flagCache: { value: boolean; at: number } | null = null;

/** True when any org with drip on has the poke chain switched on (0206). */
export async function isPokeEnabled(): Promise<boolean> {
  if (flagCache && Date.now() - flagCache.at < FLAG_CACHE_MS) return flagCache.value;
  const rows = (await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM org_settings WHERE drip_enabled = true AND drip_poke_enabled = true
    ) AS enabled
  `)) as unknown as { enabled: boolean }[];
  const value = rows[0]?.enabled === true;
  flagCache = { value, at: Date.now() };
  return value;
}

/** Tests only: forget the cached flag so the next read hits the database. */
export function resetPokeFlagCacheForTests(): void {
  flagCache = null;
}

export function isPokeRequest(req: Request): boolean {
  return req.headers.get(POKE_HEADER) === "1";
}

/**
 * Ask `job` to run soon. NEVER THROWS and never blocks on the job's work: the
 * cron tick is the fallback for every failure here.
 *
 * Always records the request (poke_requested_at), so a run already holding the
 * lease runs again. Sends the wake-up HTTP request only when nobody holds the
 * lease AND no earlier wake-up is still unconsumed — "unconsumed" meaning sent
 * after the job's latest run started and less than POKE_MIN_GAP_MS ago (after
 * that it is presumed lost and may be re-sent).
 */
export async function requestPoke(job: PokeJob, from: string): Promise<void> {
  try {
    if (!(await isPokeEnabled())) return;
    const rows = (await db.execute(sql`
      INSERT INTO cron_locks (job_name, poke_requested_at, poke_dispatched_at)
      VALUES (${job}, now(), now())
      ON CONFLICT (job_name) DO UPDATE SET
        poke_requested_at = now(),
        poke_dispatched_at = CASE
          WHEN (cron_locks.lease_until IS NULL OR cron_locks.lease_until < now())
           AND (cron_locks.poke_dispatched_at IS NULL
                OR cron_locks.poke_dispatched_at <= cron_locks.last_run_started_at
                OR cron_locks.poke_dispatched_at
                     < now() - interval '1 millisecond' * ${POKE_MIN_GAP_MS})
          THEN now()
          ELSE cron_locks.poke_dispatched_at
        END
      RETURNING (poke_dispatched_at = poke_requested_at) AS dispatch
    `)) as unknown as { dispatch: boolean }[];
    if (rows[0]?.dispatch !== true) return;
    await dispatch(job, from);
  } catch (err) {
    console.error(`[poke] request ${job} from ${from} failed (swallowed; the cron tick still runs):`, err);
  }
}

async function dispatch(job: PokeJob, from: string): Promise<void> {
  const origin = appOrigin();
  const secret = process.env.CRON_SECRET;
  if (!origin || !secret) {
    console.warn(`[poke] cannot dispatch ${job}: ${origin ? "CRON_SECRET" : "NEXT_PUBLIC_SITE_URL"} is unset`);
    return;
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${secret}`,
    [POKE_HEADER]: "1",
    "x-camman-poke-from": from,
  };
  // Preview deployments sit behind Vercel deployment protection.
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  const res = await fetch(`${origin}${ROUTE[job]}`, {
    method: "GET",
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
  });
  if (res.status !== 202) {
    console.warn(`[poke] ${job} (from ${from}) answered ${res.status}, not 202`);
  }
}

export interface PokeRunContext {
  trigger: PokeTrigger;
  /** 1 for the first run of this invocation, 2+ for a re-run. */
  run: number;
  /** Time left in the invocation's budget, for steps that take a deadline. */
  remainingMs: number;
}

export interface LeasedJobOptions {
  trigger: PokeTrigger;
  /** Lease TTL; defaults to the cron lease (4 min). Must cover the route's maxDuration. */
  ttlMs?: number;
  /** Total time this invocation may spend across runs. */
  budgetMs: number;
  /** A re-run starts only if at least this much of the budget is left. */
  minRunMs: number;
  /** One run of the step. Return { again: true } to ask for a re-run (budget permitting). */
  runOnce: (ctx: PokeRunContext) => Promise<{ again?: boolean } | void>;
}

/**
 * Run a step under its job lease, with pokes honoured when the flag is on.
 *
 * ⭐ FLAG OFF ⇒ EXACTLY THE OLD CRON PATH: withCronLease(job, one run), no extra
 * write, no re-run, no wait.
 *
 * Flag on: each run stamps last_run_started_at; after it, a poke that arrived
 * during the run (poke_requested_at > last_run_started_at) earns a re-run,
 * spaced POKE_MIN_GAP_MS from the previous start. A poke-triggered first run
 * also waits out the gap — a cron-triggered one never waits.
 */
export async function runLeasedJob(
  job: PokeJob,
  opts: LeasedJobOptions,
): Promise<CronLeaseOutcome<number>> {
  const pokeOn = await isPokeEnabled();
  const leased = await withCronLease(
    job,
    () => (pokeOn ? pokeLoop(job, opts) : opts.runOnce({ trigger: opts.trigger, run: 1, remainingMs: opts.budgetMs }).then(() => 1)),
    opts.ttlMs,
  );
  if (pokeOn && leased.ran) {
    // Close the window between the loop's last check and the lease release: a
    // poke landing there saw the lease held, so it did not dispatch.
    if (await requestedSinceLastRun(job)) await requestPoke(job, `${job}:tail`);
  }
  return leased;
}

async function pokeLoop(job: PokeJob, opts: LeasedJobOptions): Promise<number> {
  const started = Date.now();
  let run = 0;
  for (;;) {
    const gap = (await db.execute(sql`
      SELECT GREATEST(0, ${POKE_MIN_GAP_MS}
                         - extract(epoch FROM (now() - last_run_started_at)) * 1000)::int AS wait_ms
      FROM cron_locks WHERE job_name = ${job}
    `)) as unknown as { wait_ms: number | null }[];
    const waitMs = Number(gap[0]?.wait_ms ?? 0);
    if (run > 0 && Date.now() - started + waitMs > opts.budgetMs - opts.minRunMs) break;
    if (waitMs > 0 && (run > 0 || opts.trigger === "poke")) await sleep(waitMs);

    await db.execute(sql`UPDATE cron_locks SET last_run_started_at = now() WHERE job_name = ${job}`);
    run++;
    const r = await opts.runOnce({
      trigger: opts.trigger,
      run,
      remainingMs: Math.max(0, opts.budgetMs - (Date.now() - started)),
    });

    const again = (r && r.again === true) || (await requestedSinceLastRun(job));
    if (!again) break;
    if (Date.now() - started > opts.budgetMs - opts.minRunMs) break;
  }
  return run;
}

async function requestedSinceLastRun(job: PokeJob): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT (poke_requested_at > last_run_started_at) AS again
    FROM cron_locks WHERE job_name = ${job}
  `)) as unknown as { again: boolean | null }[];
  return rows[0]?.again === true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
