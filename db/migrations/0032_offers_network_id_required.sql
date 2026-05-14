-- Offers.network_id is now required.
--
-- Pre-condition: scripts/check-null-network-ids.ts and
-- scripts/delete-orphan-test-offers.ts were run beforehand to remove the
-- 6 NULL-network_id rows left over by scripts/test-segment-rules-api.ts.
-- If this migration fails with a NOT NULL violation, re-run the check
-- script — there are more rows than expected.
--
-- Also flips ON DELETE behavior from SET NULL to RESTRICT, since a NULL
-- column can no longer absorb a deleted network's reference. Practically
-- this means: archive offers under a network before you can hard-delete
-- the network. (Networks are soft-deleted via status='archived' anyway,
-- so this is a defensive constraint, not a user-facing change.)

ALTER TABLE public.offers ALTER COLUMN network_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE public.offers DROP CONSTRAINT IF EXISTS offers_network_id_affiliate_networks_id_fk;
--> statement-breakpoint
ALTER TABLE public.offers ADD CONSTRAINT offers_network_id_affiliate_networks_id_fk
  FOREIGN KEY (network_id) REFERENCES public.affiliate_networks(id) ON DELETE RESTRICT;
