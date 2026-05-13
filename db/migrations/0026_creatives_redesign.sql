-- Creatives redesign:
--   * Drop sms_provider_id and brand_id (no longer associated; those live on the stage)
--   * Convert single offer_id → many-to-many via creative_offers junction
--   * Add quality (high/average/poor/unknown) + sequence_placement (1st/2nd/3rd/any/unknown)
--   * Add applies_to_all_offers boolean
--   * Drop status state machine; status becomes active|archived only
--
-- Order is load-bearing: create junction → backfill from existing offer_id →
-- THEN drop the column. Backfilling after the drop would leave existing
-- creatives orphaned.

-- ============ 1. Pre-migration data normalization ============
-- Collapse the 4-state lifecycle (draft/pending/ready/paused) into 'active'.
-- 'archived' rows stay archived.
-- The existing status CHECK constraint allows only the old 5-value set,
-- so dropping it BEFORE the UPDATE is required — otherwise UPDATE → 'active'
-- would fail the CHECK (which doesn't permit 'active' yet). The constraint
-- is recreated with the new 2-value set in step 6.
ALTER TABLE public.creatives DROP CONSTRAINT IF EXISTS creatives_status_check;--> statement-breakpoint

UPDATE public.creatives
SET status = 'active'
WHERE status IN ('draft', 'pending', 'ready', 'paused');
--> statement-breakpoint

-- ============ 2. Create the creative_offers junction ============
CREATE TABLE public.creative_offers (
  creative_id integer NOT NULL REFERENCES public.creatives(id) ON DELETE CASCADE,
  offer_id integer NOT NULL REFERENCES public.offers(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  PRIMARY KEY (creative_id, offer_id)
);
--> statement-breakpoint
CREATE INDEX creative_offers_offer_id_idx ON public.creative_offers(offer_id);--> statement-breakpoint
CREATE INDEX creative_offers_org_id_idx ON public.creative_offers(org_id);--> statement-breakpoint

-- ============ 3. Backfill the junction from existing offer_id ============
-- Existing creatives all had a non-null offer_id (it was NOT NULL).
INSERT INTO public.creative_offers (creative_id, offer_id, org_id)
SELECT id, offer_id, org_id FROM public.creatives;
--> statement-breakpoint

-- ============ 4. Drop the old FK + index + column on creatives ============
ALTER TABLE public.creatives DROP CONSTRAINT IF EXISTS creatives_offer_id_offers_id_fk;--> statement-breakpoint
DROP INDEX IF EXISTS public.creatives_offer_id_idx;--> statement-breakpoint
ALTER TABLE public.creatives DROP COLUMN offer_id;--> statement-breakpoint

ALTER TABLE public.creatives DROP CONSTRAINT IF EXISTS creatives_sms_provider_id_sms_providers_id_fk;--> statement-breakpoint
DROP INDEX IF EXISTS public.creatives_sms_provider_id_idx;--> statement-breakpoint
ALTER TABLE public.creatives DROP COLUMN sms_provider_id;--> statement-breakpoint

ALTER TABLE public.creatives DROP CONSTRAINT IF EXISTS creatives_brand_id_brands_id_fk;--> statement-breakpoint
DROP INDEX IF EXISTS public.creatives_brand_id_idx;--> statement-breakpoint
ALTER TABLE public.creatives DROP COLUMN brand_id;--> statement-breakpoint

-- ============ 5. New columns on creatives ============
ALTER TABLE public.creatives
  ADD COLUMN quality text NOT NULL DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE public.creatives
  ADD CONSTRAINT creatives_quality_check
  CHECK (quality IN ('high', 'average', 'poor', 'unknown'));--> statement-breakpoint

ALTER TABLE public.creatives
  ADD COLUMN sequence_placement text NOT NULL DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE public.creatives
  ADD CONSTRAINT creatives_sequence_placement_check
  CHECK (sequence_placement IN ('1st', '2nd', '3rd', 'any', 'unknown'));--> statement-breakpoint

ALTER TABLE public.creatives
  ADD COLUMN applies_to_all_offers boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- ============ 6. Tighten status CHECK to active|archived ============
-- (Old constraint was dropped in step 1 so the UPDATE could land.)
ALTER TABLE public.creatives
  ADD CONSTRAINT creatives_status_check
  CHECK (status IN ('active', 'archived'));--> statement-breakpoint

-- ============ 7. RLS on creative_offers ============
-- Junction inherits the creatives access model: anyone in the org can read;
-- operator+ can insert/delete (i.e., manage associations).
ALTER TABLE public.creative_offers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "creative_offers_select_own_org"
  ON public.creative_offers FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "creative_offers_insert_operator_or_higher"
  ON public.creative_offers FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = creative_offers.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "creative_offers_delete_operator_or_higher"
  ON public.creative_offers FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = creative_offers.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
