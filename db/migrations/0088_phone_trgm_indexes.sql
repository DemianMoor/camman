-- Migration 0088: trigram GIN indexes for substring phone search.
-- Purely additive — NO column, constraint, data, or semantic change. Every index
-- backs the leading-wildcard phone search (ILIKE '%x%') on the four audience
-- tables (contacts / opt_outs / opt_ins / clickers). A plain btree cannot serve a
-- leading-wildcard match, so today those searches force a full org-partition scan
-- on BOTH the page query and the mandatory COUNT(*). Measured on real data
-- (752K contacts): the contacts search COUNT was ~820 ms/search on a Seq Scan.
-- A pg_trgm GIN index turns that into a bitmap index scan.
--
-- Index-build locking note: these are plain (non-CONCURRENT) CREATE INDEX
-- statements because drizzle-kit migrate runs each migration inside a transaction
-- (CONCURRENTLY cannot). Each takes a brief SHARE lock (blocks writes, allows
-- reads) on its table for the build. contacts is the large one (millions at
-- maturity) — apply during a low-write window, or pre-build by hand with
-- CREATE INDEX CONCURRENTLY before applying (the IF NOT EXISTS below then no-ops).
-- At current volume the inline build is fine.
--
-- pg_trgm lives in the `extensions` schema (Supabase convention; it's already on
-- the role search_path), so the opclass is referenced as extensions.gin_trgm_ops.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS contacts_phone_number_trgm_idx
  ON public.contacts USING gin (phone_number extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS opt_outs_phone_number_trgm_idx
  ON public.opt_outs USING gin (phone_number extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS opt_ins_phone_number_trgm_idx
  ON public.opt_ins USING gin (phone_number extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS clickers_phone_number_trgm_idx
  ON public.clickers USING gin (phone_number extensions.gin_trgm_ops);
