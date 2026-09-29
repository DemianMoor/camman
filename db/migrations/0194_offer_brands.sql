-- 0194 — offer ↔ brand assignment (card 869f94t0t).
--
-- WHAT IT IS. Which brands an offer may be picked under. Read ONLY by the
-- campaign editor's / clickers-upload offer pickers and by the campaign
-- POST/PATCH save-time check (which fires only when brand or offer CHANGES vs
-- the stored row — existing out-of-brand pairs are grandfathered). Nothing on
-- the send path, materialization, preflight, drip intake, breakers or reports
-- reads it.
--
-- ADDITIVE ONLY. No existing column changes, nothing dropped.
--
-- BACKFILL: every existing offer × every existing brand in the same org
-- (archived ones included), so on day one every campaign's pair is assigned and
-- the pickers show exactly what they show today. A brand created AFTER this
-- gets no offers by default — assignment is made from the offer screen.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.offer_brands (
  org_id     UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  offer_id   INTEGER     NOT NULL REFERENCES public.offers(id) ON DELETE CASCADE,
  brand_id   INTEGER     NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (offer_id, brand_id)
);
--> statement-breakpoint

-- "Offers for brand X" — the picker's query.
CREATE INDEX IF NOT EXISTS offer_brands_org_brand_idx
  ON public.offer_brands (org_id, brand_id);
--> statement-breakpoint

-- Tenant table: RLS on WITH an org-scoped SELECT policy and NO write policies --
-- the 0085 / 0146 / 0147 / 0149 / 0150 shape. The app writes via Drizzle and
-- enforces org scoping itself.
ALTER TABLE public.offer_brands ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "offer_brands_select_own_org" ON public.offer_brands;
--> statement-breakpoint

CREATE POLICY "offer_brands_select_own_org"
  ON public.offer_brands FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

INSERT INTO public.offer_brands (org_id, offer_id, brand_id)
SELECT o.org_id, o.id, b.id
FROM public.offers o
JOIN public.brands b ON b.org_id = o.org_id
ON CONFLICT DO NOTHING;
