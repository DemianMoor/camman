-- 0240: creatives.brand_id — each creative belongs to exactly ONE brand
-- (ClickUp 1amdve2d47v, P1 of 4).
--
-- Additive only. The column is NULLABLE on purpose: the backfill
-- (scripts/backfill-creative-brand.ts) assigns a brand to the creatives it can
-- resolve and leaves the rest NULL for the owner to map from an .xlsx. NOT NULL
-- is added in P4, after that mapping is applied and
-- scripts/verify-creative-brand.ts reports zero NULLs.
--
-- Nothing reads the column until P2 ships (picker filter, stage-save check,
-- Creatives tab filter/column). The send path never reads it — a stage that is
-- already saved keeps its creative and sends whatever the creative's brand.
--
-- ON DELETE RESTRICT, matching campaigns.brand_id: a brand that creatives point
-- at cannot be hard-deleted out from under them (brands are archived, not
-- deleted, in practice).
--
-- Index (org_id, brand_id) serves the Creatives tab brand filter and the stage
-- picker's brand filter. creatives is ~1.1K rows, so the build is instant and a
-- plain (non-CONCURRENT) CREATE INDEX is fine; lock_timeout makes the batch
-- fail fast instead of queueing behind a long reader of creatives or brands
-- (adding the FK takes SHARE ROW EXCLUSIVE on brands).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.creatives
  ADD COLUMN IF NOT EXISTS brand_id integer
  CONSTRAINT creatives_brand_id_brands_id_fk
  REFERENCES public.brands(id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS creatives_org_brand_idx
  ON public.creatives (org_id, brand_id);
