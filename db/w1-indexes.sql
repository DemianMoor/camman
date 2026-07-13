-- W1 quick-wins indexes (Task 1b of V2-PHASE0-RECON.md)
--
-- These support the propagate-clickers job (lib/links/propagate-clickers.ts),
-- the #1 database-time consumer (30.3% of total exec time, 8s mean). Before
-- these, that INSERT...SELECT did a Parallel Seq Scan of the full `clicks`
-- table plus ~92.8M lifetime seq-scans of `clickers` (recon §2, §3).
--
-- CREATE INDEX CONCURRENTLY CANNOT run inside a transaction. These were applied
-- out-of-band directly against production on 2026-07-13 (verified indisvalid=true),
-- NOT via a drizzle migration (the migration runner wraps statements in a txn).
-- Keep this file as the canonical record + rollback for the pair.
--
-- Post-apply EXPLAIN confirmed the propagate plan flipped to:
--   Index Scan using clicks_classification_scored_at_idx on clicks
--   Index Only Scan using clickers_org_contact_brand_source_offer_idx on clickers

-- Predicate `WHERE classification='human' AND scored_at IS NOT NULL` (propagate
-- source filter). Partial so it stays small — only scored clicks qualify.
CREATE INDEX CONCURRENTLY IF NOT EXISTS clicks_classification_scored_at_idx
  ON clicks (classification, scored_at)
  WHERE scored_at IS NOT NULL;

-- Satisfies the propagate NOT EXISTS anti-join key
-- (org_id, contact_id, brand_id, source, offer_id). Was previously unindexed →
-- the 100%-seq-scan hotspot on `clickers`.
CREATE INDEX CONCURRENTLY IF NOT EXISTS clickers_org_contact_brand_source_offer_idx
  ON clickers (org_id, contact_id, brand_id, source, offer_id);

-- Rollback:
-- DROP INDEX CONCURRENTLY IF EXISTS clicks_classification_scored_at_idx;
-- DROP INDEX CONCURRENTLY IF EXISTS clickers_org_contact_brand_source_offer_idx;
