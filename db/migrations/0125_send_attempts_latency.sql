-- Migration 0125: send_attempts.latency_ms — provider round-trip instrumentation.
--
-- ⚠️ ORDERING: this file is numbered 0125, NOT 0121. The unmerged
-- `feat/textrequest-send` branch already holds 0121–0124 (also unapplied). Apply
-- 0121–0124 FIRST, then this one. Applying 0125 against a database that has not
-- yet taken 0121–0124 records it out of order in the drizzle journal.
--
-- ⚠️ SNAPSHOT CHAIN: meta/0125_snapshot.json currently points prevId at 0120 —
-- the newest migration on THIS branch. When 0121–0124 merge first, re-point it at
-- 0124's snapshot id, or verify-migration-integrity will flag a broken chain.
--
-- WHAT/WHY: send_attempts records what the provider SAID (verbatim body, HTTP
-- status, normalized result, classification) but never how long it took, so the
-- most basic throughput question — is the provider slow, or are we? — could not
-- be answered from stored data at all. The drain's send slices are dominated by
-- the per-recipient HTTP round-trip (no adapter has a usable batch endpoint), so
-- this is the number that decides whether more concurrency would help.
--
-- Additive + nullable: NULL means "not measured" (historical rows, and the
-- not-yet-implemented adapters), never zero. Populated by lib/sends/drain.ts from
-- SendSmsResult.latencyMs, which lib/sends/texthub.ts and
-- lib/sends/providers/ahoi.ts clock around their fetch on every exit path
-- (including timeouts — a slow failure is the case worth seeing).
--
-- No index: this is analytical, queried by aggregate over a date range that the
-- existing created_at ordering already serves. Add one only if a real query needs it.
--
-- The drain writes the column ONLY when it exists (a memoized information_schema
-- probe, lib/sends/drain.ts hasLatencyColumn), so the code is safe to deploy on
-- either side of this migration.

ALTER TABLE public.send_attempts
  ADD COLUMN IF NOT EXISTS latency_ms integer;
--> statement-breakpoint

COMMENT ON COLUMN public.send_attempts.latency_ms IS
  'Provider round-trip in milliseconds (request issued -> response body read), measured by the sending adapter. NULL = not measured (historical rows, or an adapter that issues no request).';
