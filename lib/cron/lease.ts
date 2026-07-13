import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// Generic single-runner guard for scheduled crons — a lease ROW, not a session
// advisory lock. Advisory locks are unsafe through the transaction pooler
// (port 6543, prepare=false): a backend reassignment between statements can
// lose or strand the lock. Same reasoning and CAS-on-value discipline as the
// Telnyx worker lease (lib/telnyx/lease.ts), generalized to N jobs via a
// keyed `cron_locks` row.
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
export const CRON_LEASE_MS = 4 * 60 * 1000; // 4 min — safely past the 60s maxDuration

export type CronLeaseOutcome<T> =
  | { ran: true; result: T }
  | { ran: false; skippedCount: number };

// Run `fn` under the named lease. If another run holds an unexpired lease,
// `fn` does NOT run: the skip is logged and counted (no alert — overlap is
// expected backpressure, not an incident). The lease is always released on
// exit, even if `fn` throws.
export async function withCronLease<T>(
  jobName: string,
  fn: () => Promise<T>,
  ttlMs: number = CRON_LEASE_MS,
): Promise<CronLeaseOutcome<T>> {
  const until = new Date(Date.now() + ttlMs).toISOString();

  // Claim iff free (row absent) or expired. Self-creating via upsert so no seed
  // row is needed. RETURNING yields a row only when WE won the claim.
  const claimed = await db.execute(sql`
    INSERT INTO cron_locks (job_name, lease_until)
    VALUES (${jobName}, ${until}::timestamptz)
    ON CONFLICT (job_name) DO UPDATE
      SET lease_until = ${until}::timestamptz
      WHERE cron_locks.lease_until IS NULL OR cron_locks.lease_until < now()
    RETURNING lease_until
  `);

  if (claimed.length === 0) {
    const bumped = await db.execute(sql`
      UPDATE cron_locks
      SET skipped_count = skipped_count + 1, last_skipped_at = now()
      WHERE job_name = ${jobName}
      RETURNING skipped_count
    `);
    const skippedCount = Number(
      (bumped[0] as { skipped_count?: number } | undefined)?.skipped_count ?? 0,
    );
    console.warn(
      `[cron-lease] ${jobName} skipped — prior run still holds the lease (skipped_count=${skippedCount})`,
    );
    return { ran: false, skippedCount };
  }

  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    // CAS on our exact token so we never clear a successor's lease (if we
    // overran and someone else legitimately reclaimed after expiry).
    await db.execute(sql`
      UPDATE cron_locks SET lease_until = NULL
      WHERE job_name = ${jobName} AND lease_until = ${until}::timestamptz
    `);
  }
}
