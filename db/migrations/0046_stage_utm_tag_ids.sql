-- Add per-stage selected UTM tag ids for the Full URL link-builder.
--
-- Ordered jsonb array of utm_tags.id. The stage form lets the operator pick
-- UTM tags (3 quick pills + a popup for the rest); each selected tag appends
-- `&<label>=<value_source>` to the stage's full_url. Stored as jsonb (not a
-- junction) to keep ordering trivial and match the offers.sales_pages
-- precedent; FK ownership is verified in the API on save.
--
-- Additive + defaulted, so existing rows backfill to '[]' with no rewrite of
-- their stored full_url.

ALTER TABLE public.campaign_stages
  ADD COLUMN utm_tag_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
