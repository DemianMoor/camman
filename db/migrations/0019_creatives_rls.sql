-- Creatives are operational SMS copy. Authoring is operator-level: drafts
-- and pending submissions are everyday work. Manager+ gating happens at the
-- API layer for the pending → ready approval and for restore.

ALTER TABLE public.creatives ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "creatives_select_own_org"
  ON public.creatives FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "creatives_insert_operator_or_higher"
  ON public.creatives FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = creatives.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "creatives_update_operator_or_higher"
  ON public.creatives FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = creatives.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = creatives.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
