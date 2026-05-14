-- Two related additions to campaigns:
--   * audience_contact_group_ids — companion to audience_segment_ids.
--     The frozen audience is the UNION of (contacts in any selected
--     segment) ∪ (contacts in any selected contact group). Either or
--     both can be non-empty.
--   * audience_cap — optional integer. When set, the audience snapshot
--     at activation time takes a random sample of N contacts from the
--     resolved pool instead of the full pool. Frozen along with the
--     pool — re-activating won't re-sample.

ALTER TABLE public.campaigns
  ADD COLUMN audience_contact_group_ids integer[] NOT NULL DEFAULT '{}'::integer[];
--> statement-breakpoint
ALTER TABLE public.campaigns
  ADD COLUMN audience_cap integer;
--> statement-breakpoint
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_audience_cap_check
  CHECK (audience_cap IS NULL OR audience_cap > 0);
