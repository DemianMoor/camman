-- Campaign-level "exclude leads who already received this offer in a previous
-- campaign" toggle (Phase 2 of content dedup & offer exposure). This is the
-- operator's OPT-IN offer-level lever — LAYER 3 of the eligibility filter
-- (see docs/04-features/content-dedup.md). The always-on hard creative rule
-- (creative_exposures) protects every send regardless of this flag.
--
-- Default FALSE: offer-level exclusion is off unless the operator turns it on.
-- Existing campaigns inherit the default via the column default; no data
-- migration needed. (Distinct from campaigns.exclude_in_use_contacts, which
-- defaults true and concerns in-flight active-campaign reservation, not prior
-- offer exposure.)

ALTER TABLE public.campaigns
  ADD COLUMN exclude_prior_offer_contacts boolean NOT NULL DEFAULT false;
