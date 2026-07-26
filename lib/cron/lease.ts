import "server-only";

import { db } from "@/db/client";
import { withKeyedLease, type CronLeaseOutcome } from "@/lib/cron/keyed-lease";

export type { CronLeaseOutcome };

// Generic single-runner guard for scheduled crons — a lease ROW, not a session
// advisory lock. Advisory locks are unsafe through the transaction pooler
// (port 6543, prepare=false): a backend reassignment between statements can
// lose or strand the lock. Same reasoning and CAS-on-value discipline as the
// Telnyx worker lease (lib/telnyx/lease.ts), generalized to N jobs via a
// keyed `cron_locks` row. The claim/release mechanics live in
// lib/cron/keyed-lease.ts (which is NOT server-only, so the test harnesses can
// exercise it under `tsx`); this module just binds the module-level pool.
//
// Why a lease at all when maxDuration (60s) is well under every cron interval
// (5–15 min)? Because Vercel killing the function at its timeout does NOT stop
// the SQL already in flight — a heavy UPDATE keeps running server-side after
// the Node process dies. The next tick would then pile a second copy of the
// same heavy work onto a DB that's still draining the first. The lease makes
// the next tick skip until the prior run's lease clears (on clean exit) or
// expires (after a crash/kill).
//
// Scope: apply this to the SCHEDULED (cron) invocation only. Manual operator
// triggers (the "poll now" buttons) bypass it — they're rare, human-initiated,
// and must not silently no-op behind a running cron.
//
// EXCEPTION — the per-phone SEND lease (lib/sends/scheduled.ts) applies to BOTH
// the cron and the manual trigger: two drain loops on one number is a carrier
// MPS violation regardless of who started them, so that one is not a
// backpressure convenience but a compliance invariant.
export const CRON_LEASE_MS = 4 * 60 * 1000; // 4 min — safely past the 60s maxDuration

// Run `fn` under the named job-wide lease. See withKeyedLease for the semantics.
export async function withCronLease<T>(
  jobName: string,
  fn: () => Promise<T>,
  ttlMs: number = CRON_LEASE_MS,
): Promise<CronLeaseOutcome<T>> {
  return withKeyedLease(db, jobName, ttlMs, fn);
}
