-- Migration 0083: effective-dated CPA history for offers.
--
-- offers.payout_cpa is a single mutable value that gets overwritten when a
-- network changes the CPA mid-flight, which destroys the record of what the rate
-- USED to be. This table keeps that history: the write path (app/api/offers)
-- closes the current row (effective_to = now()) and opens a new one on every CPA
-- change instead of overwriting. offers.payout_cpa stays updated as the current-
-- rate cache. Revenue is NOT recomputed from this — keitaro_stage_results.revenue
-- remains the source of truth; this table is for displaying/auditing "the rate
-- that applied when".
--
-- Backfill: one row per existing CPA offer — payout_cpa = current offers.payout_cpa,
-- effective_from = the offer's created_at, effective_to = NULL (current). Offers
-- on a revshare model (payout_cpa NULL) get no row. Idempotent: only seeds when
-- the table is empty, so re-applying never double-seeds.

CREATE TABLE public.offer_payouts (
  id             serial PRIMARY KEY,
  org_id         uuid    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  offer_id       integer NOT NULL REFERENCES public.offers(id) ON DELETE CASCADE,
  payout_cpa     numeric(12, 4) NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  created_at     timestamptz DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX offer_payouts_offer_effective_idx
  ON public.offer_payouts (offer_id, effective_from);
--> statement-breakpoint

-- At most ONE current (open-ended) row per offer.
CREATE UNIQUE INDEX offer_payouts_one_current_per_offer_uniq
  ON public.offer_payouts (offer_id)
  WHERE effective_to IS NULL;
--> statement-breakpoint

-- RLS: org-scoped reads. Writes happen via the app's privileged connection in
-- the offers create/update routes, so there is no authenticated write policy
-- (mirrors keitaro_stage_results / campaign_events).
ALTER TABLE public.offer_payouts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "offer_payouts_select_own_org"
  ON public.offer_payouts FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

-- Seed the current rate as the first history row for every CPA offer.
INSERT INTO public.offer_payouts (org_id, offer_id, payout_cpa, effective_from, effective_to)
SELECT org_id, id, payout_cpa, created_at, NULL
FROM public.offers
WHERE payout_cpa IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.offer_payouts);
