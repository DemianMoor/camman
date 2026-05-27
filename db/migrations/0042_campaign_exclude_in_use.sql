-- Campaign-level "exclude contacts already in use by another active
-- campaign" toggle. Broader counterpart to segments.exclude_in_use_contacts:
-- it applies across the campaign's ENTIRE audience (contact groups + segments),
-- which the per-segment flag can't reach for a group-only audience.
--
-- Defaults true (on by default for new campaigns, per product decision).
-- Existing rows backfill to true: active/paused/completed campaigns already
-- have a frozen pool so this is inert for them; existing drafts pick it up at
-- their next activation and can toggle it off per campaign while still in draft.

ALTER TABLE public.campaigns
  ADD COLUMN exclude_in_use_contacts boolean NOT NULL DEFAULT true;
