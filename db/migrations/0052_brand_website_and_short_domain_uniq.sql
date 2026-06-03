-- Brand settings: one short domain per brand + a brand "main website".
--
-- short_domains becomes strictly one-per-brand (the brand↔domain mapping mint
-- reads). brands.short_link_base is now legacy — nothing functional reads it
-- (mint/kickoff use short_domains); the UI stops surfacing it. The column is
-- left in place to avoid data loss; it can be dropped in a later migration.

-- One short domain per brand. short_domains has 0 rows today, so no existing
-- data violates this. (org_id, domain) uniqueness from migration 0048 stays,
-- so two brands still can't claim the same host.
CREATE UNIQUE INDEX short_domains_brand_id_uniq
  ON public.short_domains (brand_id);
--> statement-breakpoint

-- The old non-unique brand_id index is now redundant (the unique one covers
-- brand_id lookups).
DROP INDEX IF EXISTS short_domains_brand_id_idx;
--> statement-breakpoint

-- Brand main website — target for a future bare-root redirect (short domain hit
-- at "/"). Stored as a full URL; nullable.
ALTER TABLE public.brands
  ADD COLUMN website text;
