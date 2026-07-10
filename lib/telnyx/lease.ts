import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// Single-runner lease for the worker drain — a lease ROW, not a session advisory
// lock (advisory locks are unsafe through the transaction pooler: backend
// reassignment can lose/strand them). Correctness without a token column: we CAS
// on the exact worker_lease_until value we last wrote. We always SET a value WE
// generate (ms precision) so it round-trips through JS Date exactly for the CAS;
// only the expiry comparison uses the DB clock (now()).
export const LEASE_MS = 4 * 60 * 1000; // 4 minutes

// Claim the lease iff it's free (NULL) or expired (< now()). Returns the lease
// token (the ISO value we set) on success, or null if another runner holds it.
export async function claimWorkerLease(now: Date = new Date()): Promise<string | null> {
  const until = new Date(now.getTime() + LEASE_MS).toISOString();
  const rows = await db.execute(sql`
    UPDATE lookup_settings SET worker_lease_until = ${until}::timestamptz
    WHERE id = true AND (worker_lease_until IS NULL OR worker_lease_until < now())
    RETURNING worker_lease_until
  `);
  return rows.length > 0 ? until : null;
}

// Heartbeat-renew. CAS on the previous token — returns the new token, or null if
// the lease was lost (we stalled past expiry and someone else claimed it), in
// which case the caller must stop.
export async function renewWorkerLease(
  prevToken: string,
  now: Date = new Date(),
): Promise<string | null> {
  const until = new Date(now.getTime() + LEASE_MS).toISOString();
  const rows = await db.execute(sql`
    UPDATE lookup_settings SET worker_lease_until = ${until}::timestamptz
    WHERE id = true AND worker_lease_until = ${prevToken}::timestamptz
    RETURNING worker_lease_until
  `);
  return rows.length > 0 ? until : null;
}

// Clear the lease on clean exit (CAS so we never clear someone else's lease).
export async function releaseWorkerLease(prevToken: string): Promise<void> {
  await db.execute(sql`
    UPDATE lookup_settings SET worker_lease_until = NULL
    WHERE id = true AND worker_lease_until = ${prevToken}::timestamptz
  `);
}
