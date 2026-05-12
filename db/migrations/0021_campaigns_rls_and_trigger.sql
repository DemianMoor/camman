-- Campaigns + stages: operator-level CRUD. Reassignment (changing
-- assigned_to_user_id) and restore are enforced at the API layer rather
-- than via RLS — encoding "the value of THIS column may only change when
-- the user has a specific role" in a USING clause is verbose and easy to
-- get wrong; the route handler is the single source of truth for those
-- transitions.

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.campaign_stages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.campaign_audience_pool ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ============ campaigns ============

CREATE POLICY "campaigns_select_own_org"
  ON public.campaigns FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "campaigns_insert_operator_or_higher"
  ON public.campaigns FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = campaigns.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "campaigns_update_operator_or_higher"
  ON public.campaigns FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = campaigns.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = campaigns.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

-- ============ campaign_stages ============

CREATE POLICY "stages_select_own_org"
  ON public.campaign_stages FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "stages_insert_operator_or_higher"
  ON public.campaign_stages FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = campaign_stages.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "stages_update_operator_or_higher"
  ON public.campaign_stages FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = campaign_stages.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = campaign_stages.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

-- ============ campaign_audience_pool ============
-- Read-only to users; writes happen only through the server's service-role
-- connection during campaign creation. No insert/update/delete policies.

CREATE POLICY "campaign_audience_pool_select_own_org"
  ON public.campaign_audience_pool FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

-- ============ Trigger: auto-assign stage_number per campaign ============
-- BEFORE INSERT so the value is in place before UNIQUE checks fire. The
-- UNIQUE (campaign_id, stage_number) constraint serves as the backstop
-- against concurrent inserts racing — one will succeed, the other will
-- fail and the client should retry.
CREATE OR REPLACE FUNCTION public.assign_stage_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.stage_number IS NULL THEN
    SELECT COALESCE(MAX(stage_number), 0) + 1
      INTO NEW.stage_number
    FROM public.campaign_stages
    WHERE campaign_id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS campaign_stages_assign_stage_number ON public.campaign_stages;--> statement-breakpoint
CREATE TRIGGER campaign_stages_assign_stage_number
  BEFORE INSERT ON public.campaign_stages
  FOR EACH ROW EXECUTE FUNCTION public.assign_stage_number();
