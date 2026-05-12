-- Drafts can be saved with zero required fields. The "frozen audience"
-- semantic is preserved at activation time, not at draft save time —
-- name, brand, and offer become required at the draft → active transition,
-- enforced at the API layer rather than the DB. FK constraints stay in
-- place so any non-null value is still validated against brands/offers.

ALTER TABLE public.campaigns
  ALTER COLUMN name DROP NOT NULL,
  ALTER COLUMN brand_id DROP NOT NULL,
  ALTER COLUMN offer_id DROP NOT NULL;
