-- Enable RLS on the new lookup tables.
ALTER TABLE public.utm_tags ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.segment_groups ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- utm_tags policies (manager+ for CUD; soft-delete only).
CREATE POLICY "utm_tags_select_own_org"
  ON public.utm_tags
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "utm_tags_insert_manager_or_higher"
  ON public.utm_tags
  FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = utm_tags.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "utm_tags_update_manager_or_higher"
  ON public.utm_tags
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = utm_tags.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = utm_tags.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- segment_groups policies (manager+ for CUD; soft-delete only).
CREATE POLICY "segment_groups_select_own_org"
  ON public.segment_groups
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "segment_groups_insert_manager_or_higher"
  ON public.segment_groups
  FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = segment_groups.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "segment_groups_update_manager_or_higher"
  ON public.segment_groups
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = segment_groups.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = segment_groups.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- No DELETE policies — archive via status.
