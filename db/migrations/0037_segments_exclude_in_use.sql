-- Per-segment toggle: when true, contacts already snapshotted into any
-- active campaign's audience pool are excluded from this segment's
-- effective audience (preview, audience tab, and any new campaign's
-- snapshot that uses this segment). Lets the operator reserve
-- contacts for one campaign at a time without managing manual exclusion
-- lists.
--
-- "In use" = exists in campaign_audience_pool for a campaign with
-- status = 'active'. Paused / completed / archived campaigns do NOT
-- block contacts.
--
-- Default false preserves existing-segment behavior on deploy.

ALTER TABLE public.segments
  ADD COLUMN exclude_in_use_contacts boolean NOT NULL DEFAULT false;
