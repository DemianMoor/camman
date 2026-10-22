-- 0219: stage_sends (org_id, contact_id, sent_at) INCLUDE (campaign_id) WHERE status = 'sent'.
-- Additive only. Backs the BATCHED nightly contact-engagement recount (plan approved
-- 2026-10-21): each batch reads one contact-id range of sent rows. No index reached
-- stage_sends by contact_id for sent rows, so a batch fell back to walking all of
-- stage_sends_sent_at_contact_idx (contact_id is its second column) plus ~216K heap
-- fetches — ~11x the single pass's cost across 30 batches (EXPLAIN, 2026-10-21).
-- INCLUDE (campaign_id) makes the facts AND offers reads index-only.
--
-- PRODUCTION: built FIRST, without a write lock, by
-- scripts/apply-stage-sends-contact-sent-index-concurrent.ts (CREATE INDEX
-- CONCURRENTLY cannot run inside drizzle-kit's migration transaction), so this
-- statement no-ops there. On a fresh/preview DB it builds inline.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stage_sends_org_contact_sent_idx
  ON public.stage_sends (org_id, contact_id, sent_at) INCLUDE (campaign_id)
  WHERE status = 'sent';
