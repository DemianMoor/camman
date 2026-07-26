import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

// Generic keyed single-runner guard — a lease ROW in `cron_locks`, not a session
// advisory lock. Advisory locks are unsafe through the transaction pooler
// (port 6543, prepare=false): a backend reassignment between statements can
// lose or strand the lock. Same reasoning and CAS-on-value discipline as the
// Telnyx worker lease (lib/telnyx/lease.ts).
//
// This module deliberately does NOT import "server-only" (and does NOT import
// the `db` VALUE — the handle is always passed in), so it can be exercised by
// the `scripts/test-*.ts` harnesses under `tsx`. The job-wide wrapper that binds
// the module-level pool lives in lib/cron/lease.ts, which IS server-only.

export type LeaseDbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CronLeaseOutcome<T> =
  | { ran: true; result: T }
  | { ran: false; skippedCount: number };

// Run `fn` under the lease named `key`, on the supplied db/tx handle. If another
// run holds an UNEXPIRED lease, `fn` does NOT run: the skip is logged and
// counted (no alert — overlap is expected backpressure, not an incident). The
// lease is always released on exit, even if `fn` throws.
//
// `key` is any stable string; `cron_locks.job_name` is a free-text PK. Job-wide
// guards use the bare job name (`withCronLease`); finer-grained guards namespace
// it (e.g. `send-drain:p123` — one lease per SENDING PHONE, so two invocations
// never drain the same number concurrently while different numbers still
// proceed in parallel).
//
// CRASH SAFETY: expiry is absolute (`lease_until < now()`), so a killed run's
// lease self-clears with no heartbeat and no manual cleanup — a stuck lease that
// blocks work forever would be worse than the overlap it prevents. Callers pick
// a `ttlMs` that provably covers the work they wrap.
export async function withKeyedLease<T>(
  dbc: LeaseDbOrTx,
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<CronLeaseOutcome<T>> {
  const until = new Date(Date.now() + ttlMs).toISOString();

  // Claim iff free (row absent) or expired. Self-creating via upsert so no seed
  // row is needed. RETURNING yields a row only when WE won the claim. It is ONE
  // statement, so concurrent claimants can never both win.
  const claimed = await dbc.execute(sql`
    INSERT INTO cron_locks (job_name, lease_until)
    VALUES (${key}, ${until}::timestamptz)
    ON CONFLICT (job_name) DO UPDATE
      SET lease_until = ${until}::timestamptz
      WHERE cron_locks.lease_until IS NULL OR cron_locks.lease_until < now()
    RETURNING lease_until
  `);

  if (claimed.length === 0) {
    const bumped = await dbc.execute(sql`
      UPDATE cron_locks
      SET skipped_count = skipped_count + 1, last_skipped_at = now()
      WHERE job_name = ${key}
      RETURNING skipped_count
    `);
    const skippedCount = Number(
      (bumped[0] as { skipped_count?: number } | undefined)?.skipped_count ?? 0,
    );
    console.warn(
      `[cron-lease] ${key} skipped — prior run still holds the lease (skipped_count=${skippedCount})`,
    );
    return { ran: false, skippedCount };
  }

  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    // CAS on our exact token so we never clear a successor's lease (if we
    // overran and someone else legitimately reclaimed after expiry).
    await dbc.execute(sql`
      UPDATE cron_locks SET lease_until = NULL
      WHERE job_name = ${key} AND lease_until = ${until}::timestamptz
    `);
  }
}
