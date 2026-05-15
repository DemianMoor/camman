-- Phase 9: auto-generated, immutable tracking IDs for campaigns and stages.
--
-- Campaign tracking_id format: `<brand_id>_<offer_id>_<MMDDYY>_<seq>`
--   * date is the campaign's created_at in America/New_York
--   * seq is allocated atomically from campaign_tracking_counters
--   * generated when both brand_id and offer_id are set (drafts can have
--     NULL until those fields are filled in)
--
-- Stage tracking_id format: `<campaign_tracking_id>_s<stage_number>_c<creative_id>`
--   * generated on stage insert when both parent.tracking_id and
--     stage.creative_id are non-NULL; otherwise NULL until backfilled.
--
-- Both fields are immutable once non-NULL — see lib/tracking-id.ts +
-- the PATCH endpoints which reject any payload that tries to mutate them.

ALTER TABLE public.campaigns
  ADD COLUMN tracking_id text;
--> statement-breakpoint

-- Per-org uniqueness. Partial so multiple NULLs (drafts) coexist while
-- generated IDs are forced unique within an organization.
CREATE UNIQUE INDEX campaigns_tracking_id_org_uniq
  ON public.campaigns (org_id, tracking_id)
  WHERE tracking_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.campaign_stages
  ADD COLUMN tracking_id text;
--> statement-breakpoint

CREATE UNIQUE INDEX campaign_stages_tracking_id_org_uniq
  ON public.campaign_stages (org_id, tracking_id)
  WHERE tracking_id IS NOT NULL;
--> statement-breakpoint

-- Counter table for atomic sequence allocation per (org, brand, offer,
-- date). The allocation pattern in lib/tracking-id.ts uses a single
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING (next_seq - 1) so there
-- is no race window between SELECT and INSERT. ON DELETE CASCADE for
-- brand and offer matches existing campaign-side restrict policy in
-- spirit — counters for removed brands/offers are dead weight; they're
-- only used for new campaign tracking IDs and re-allocating sequence
-- numbers under a deleted brand isn't a concern.
CREATE TABLE public.campaign_tracking_counters (
  org_id    uuid    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  brand_id  integer NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  offer_id  integer NOT NULL REFERENCES public.offers(id) ON DELETE CASCADE,
  date_et   date    NOT NULL,
  next_seq  integer NOT NULL DEFAULT 1,
  PRIMARY KEY (org_id, brand_id, offer_id, date_et)
);
--> statement-breakpoint

-- RLS: org-scoped read/write. Allocation is performed by the server's
-- privileged DB role which bypasses RLS, but we still set policies as
-- defense in depth (matches every other domain table per CLAUDE.md §3).
ALTER TABLE public.campaign_tracking_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "campaign_tracking_counters_select_own_org"
  ON public.campaign_tracking_counters FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "campaign_tracking_counters_insert_operator_or_higher"
  ON public.campaign_tracking_counters FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = campaign_tracking_counters.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "campaign_tracking_counters_update_operator_or_higher"
  ON public.campaign_tracking_counters FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = campaign_tracking_counters.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = campaign_tracking_counters.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
