-- RLS for segment_rules.
-- Read: any org member (rules are part of segment definition; everyone
-- who can view a segment can see its rules).
-- Mutate: manager+ (consistent with segments permissions — editing
-- audience definition is an administrative action).

ALTER TABLE public.segment_rules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "segment_rules_select_own_org"
  ON public.segment_rules FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "segment_rules_insert_manager_or_higher"
  ON public.segment_rules FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = segment_rules.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "segment_rules_update_manager_or_higher"
  ON public.segment_rules FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = segment_rules.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = segment_rules.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "segment_rules_delete_manager_or_higher"
  ON public.segment_rules FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = segment_rules.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
