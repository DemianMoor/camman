-- Step 5b: split Keitaro clicks into VISITS (landing-page arrivals) vs OFFER
-- REDIRECTS (click-throughs to the offer). The poll now groups its report by
-- day + sub_id_3 + campaign and classifies each row by the Keitaro campaign
-- alias: `gk-lp-visits` ⇒ visits ("Clickers"); any other campaign ⇒ offer
-- redirects ("Offer Redirect"), and its conversions are sales. Storing them in
-- separate columns enables the funnel Clickers → Offer Redirect → Sales.
--
-- Visits and redirects are a SUBSET relationship (every redirect is also a
-- visit) and are never summed: total arrivals = visit count. See lib/keitaro/.
--
-- Pre-5b history (offer-redirect-only rows) keeps its legacy `raw_clicks` /
-- `clean_clicks`; the read layer treats those as redirect counts when the new
-- split columns are all zero. The new poll mirrors redirect totals back into
-- `raw_clicks` / `clean_clicks` so the legacy column meaning stays consistent.
ALTER TABLE public.keitaro_stage_results
  ADD COLUMN visit_clicks_raw      integer NOT NULL DEFAULT 0,
  ADD COLUMN visit_clicks_clean    integer NOT NULL DEFAULT 0,
  ADD COLUMN redirect_clicks_raw   integer NOT NULL DEFAULT 0,
  ADD COLUMN redirect_clicks_clean integer NOT NULL DEFAULT 0;
