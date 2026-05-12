-- RLS for the segment ↔ segment_group junction. Adding or removing a group
-- on a segment is an administrative action, so insert/delete are manager+.

ALTER TABLE public.segment_segment_groups ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "segment_segment_groups_select_own_org"
  ON public.segment_segment_groups FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "segment_segment_groups_insert_manager_or_higher"
  ON public.segment_segment_groups FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = segment_segment_groups.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "segment_segment_groups_delete_manager_or_higher"
  ON public.segment_segment_groups FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = segment_segment_groups.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
