-- Enable RLS on the new lookup tables.
ALTER TABLE public.routing_types ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.traffic_types ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- routing_types policies (manager+ for CUD; soft-delete only).
CREATE POLICY "routing_types_select_own_org"
  ON public.routing_types
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "routing_types_insert_manager_or_higher"
  ON public.routing_types
  FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = routing_types.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "routing_types_update_manager_or_higher"
  ON public.routing_types
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = routing_types.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = routing_types.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- traffic_types policies (manager+ for CUD; soft-delete only).
CREATE POLICY "traffic_types_select_own_org"
  ON public.traffic_types
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "traffic_types_insert_manager_or_higher"
  ON public.traffic_types
  FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = traffic_types.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "traffic_types_update_manager_or_higher"
  ON public.traffic_types
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = traffic_types.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = traffic_types.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- No DELETE policies — archive via status.
