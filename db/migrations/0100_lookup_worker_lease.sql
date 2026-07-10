-- Telnyx Number Lookup — phase 3 worker plumbing.
--
-- worker_lease_until: single-runner guard for the drain. Session advisory locks
-- are unsafe through the transaction pooler (port 6543) — backend reassignment can
-- lose/strand the lock — so we use a lease row instead. The drain claims the lease
-- via a conditional UPDATE (only if NULL or expired), leases 4 min, heartbeat-renews
-- during the run, and clears it on clean exit; a crashed drain's lease simply
-- expires and the next invocation proceeds.
--
-- lookup_queue.updated_at: stamped on every attempt (claim increments attempts +
-- sets updated_at). The daily cap sums attempts for rows touched since Warsaw
-- midnight, so failed calls and retries consume cap; updated_at also drives the
-- per-row retry cooldown (a 429'd row isn't re-claimed until it ages out).
--
-- Both columns are metadata-only adds (tiny/empty tables). Idempotent.

ALTER TABLE public.lookup_settings
  ADD COLUMN IF NOT EXISTS worker_lease_until timestamptz;
--> statement-breakpoint

ALTER TABLE public.lookup_queue
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
