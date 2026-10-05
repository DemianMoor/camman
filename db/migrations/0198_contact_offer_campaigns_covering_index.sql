-- 0198 — covering index for the campaign offer rules (Task 3 E4; owner-approved 2026-10-03).
--
-- The offer rules ("Not within Y days" / "Not more than N times") read
-- last_sent_at per contact for one offer. The (org_id, offer_id, contact_id)
-- index lacks it, so every row was a heap fetch: offer 115's read measured
-- 1.87 s with the heap vs 0.21 s index-only (Large, 2026-10-03, §9 item 3).
--
-- ⚠️ ON PRODUCTION THIS INDEX IS BUILT FIRST, CONCURRENTLY, by
-- scripts/apply-offer-cooldown-covering-index-concurrent.ts --apply (quiet
-- window). This plain CREATE INDEX IF NOT EXISTS then no-ops and only records
-- the migration in the chain. Run it alone against production BEFORE the script
-- and it holds a SHARE lock on contact_offer_campaigns (~2.57M rows) for the
-- whole build, blocking the engagement job's writes.
--
-- The old contact_offer_campaigns_org_offer_contact_idx becomes redundant;
-- dropping it needs a separate owner approval after a week (2026-10-03).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_offer_campaigns_org_offer_contact_sent_idx
  ON public.contact_offer_campaigns (org_id, offer_id, contact_id) INCLUDE (last_sent_at);
