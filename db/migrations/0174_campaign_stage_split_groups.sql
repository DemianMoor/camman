-- Campaign-level behavioural split: a split GROUP owning the three tier lanes.
--
-- ADDITIVE ONLY. Nothing reads these columns until the code that follows this
-- migration ships, and every existing behavioural lane keeps working untouched:
-- `split_group_id IS NULL` is the legacy single-parent semantics (aliveness =
-- "received parent_stage_id"), and there are ~569 such lanes in production whose
-- history must not be rewritten. There is NO backfill, by decision.
--
-- WHY A GROUP TABLE rather than an array column on each lane: the three lanes
-- share ONE source scope. Storing `source_stage_ids` three times lets the copies
-- drift; storing it once makes the group the natural unit for the release gate
-- and for the recompute timestamp the UI renders.
--
-- WHY integer[] rather than a join table: cardinality is bounded by
-- stages-per-campaign (max observed in prod: 8), the set is written once and read
-- whole (`ss.stage_id = ANY(...)`), and there is no per-element query. Ownership
-- is re-verified against the same campaign at write time -- the same convention
-- CLAUDE.md §10e already uses for set-shaped segment-rule values. A join table
-- would buy referential integrity we would hand-maintain against the CASCADE
-- anyway. (Contrast campaign_stages.utm_tag_ids, which is jsonb because it is an
-- ORDERED DISPLAY LIST, not a join key.)
--
-- WHEN source_stage_ids IS WRITTEN: at RECOMPUTE time (T-minus-15min, or lazily
-- at Phase A), NOT at split creation. A stage that completes between the split
-- being created and the recompute MUST be in the source set, so the set is
-- derived live and this column is the record of what that materialization
-- actually used. `recomputed_at` is what the UI renders as "resolved at HH:MM".
CREATE TABLE IF NOT EXISTS public.campaign_stage_split_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id integer NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  -- The P4 slip anchor: the LATEST completed stage (by sent_at) at the moment
  -- the split was created. Deliberately a SINGLE stage even though the audience
  -- source is a set -- widening the parent-complete gate to "wait on ALL source
  -- stages" would let one stalled stage hold the whole group for 24h and then
  -- HOLD it. Each lane's campaign_stages.parent_stage_id points here too, so the
  -- existing P4 / lane-count / preflight code paths are unchanged.
  anchor_stage_id integer REFERENCES public.campaign_stages(id) ON DELETE CASCADE,
  -- The completed stages whose recipients form the classification universe.
  -- Empty until the recompute runs (state='pending').
  source_stage_ids integer[] NOT NULL DEFAULT '{}',
  -- pending      -- created; source set not resolved yet
  -- materializing-- source set resolved; lanes are being materialized
  -- materialized -- ALL lanes finished (or were skipped empty); Phase B may release
  -- failed       -- a lane hit a permanent refusal; NO lane releases
  state text NOT NULL DEFAULT 'pending',
  -- When source_stage_ids was last resolved.
  recomputed_at timestamptz,
  -- Why the group failed (operator-facing, shown next to the Tier-1 alert).
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE public.campaign_stage_split_groups
  ADD CONSTRAINT campaign_stage_split_groups_state_check
  CHECK (state IN ('pending', 'materializing', 'materialized', 'failed'));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS campaign_stage_split_groups_campaign_idx
  ON public.campaign_stage_split_groups (campaign_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS campaign_stage_split_groups_org_idx
  ON public.campaign_stage_split_groups (org_id);
--> statement-breakpoint

-- RLS: org-scoped select for any member; manager+ for insert/update. No DELETE
-- policy (groups are removed only by the campaign/stage CASCADE). Mirrors
-- provider_short_codes (0041).
ALTER TABLE public.campaign_stage_split_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "campaign_stage_split_groups_select_own_org"
  ON public.campaign_stage_split_groups
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "campaign_stage_split_groups_insert_manager_or_higher"
  ON public.campaign_stage_split_groups
  FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = campaign_stage_split_groups.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "campaign_stage_split_groups_update_manager_or_higher"
  ON public.campaign_stage_split_groups
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = campaign_stage_split_groups.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = campaign_stage_split_groups.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- The lane -> group link. NULL for every existing lane (legacy single-parent
-- semantics) and for every ordinary stage.
ALTER TABLE public.campaign_stages
  ADD COLUMN IF NOT EXISTS split_group_id uuid
  REFERENCES public.campaign_stage_split_groups(id) ON DELETE SET NULL;
--> statement-breakpoint

-- Sparse -- only grouped lanes carry it. Backs "all lanes of this group".
CREATE INDEX IF NOT EXISTS campaign_stages_split_group_id_idx
  ON public.campaign_stages (split_group_id)
  WHERE split_group_id IS NOT NULL;
--> statement-breakpoint

-- Terminal marker for a lane that resolved to ZERO recipients.
--
-- This is a PIPELINE marker, not a `status` value, and that distinction is
-- deliberate: campaign_stages.status is the operator's manual record of campaign
-- results (see lib/stages/stage-status.ts) -- 227 tracked stages in production
-- have sent_at set while carrying a status outside ('success','sent'). The send
-- pipeline's own terminal markers are all nullable timestamps
-- (schedule_missed_at, slip_hold_at, preflight_aborted_at) and this joins them.
--
-- WHY IT EXISTS: kickoff's `no_recipients` is a PERMANENT refusal, so today a
-- zero-recipient stage is burned as schedule_missed_at and renders Red "needs
-- attention". Under campaign-level classification a zero-count lane is ROUTINE
-- (tier 2 measures 28-323 contacts on the widest production campaigns and will
-- genuinely be 0 on smaller ones), so it must read as a benign skip, not a
-- failure -- and it must still satisfy its group so the other two lanes release.
ALTER TABLE public.campaign_stages
  ADD COLUMN IF NOT EXISTS skipped_empty_at timestamptz;
--> statement-breakpoint

-- Phase A's due-selection must not re-consider a lane it already skipped, the
-- same way it excludes schedule_missed_at. Widen the existing partial index's
-- predicate to match by replacing it.
DROP INDEX IF EXISTS campaign_stages_scheduled_due_idx;
--> statement-breakpoint

CREATE INDEX campaign_stages_scheduled_due_idx
  ON public.campaign_stages (scheduled_at)
  WHERE sent_at IS NULL AND schedule_missed_at IS NULL AND skipped_empty_at IS NULL;
