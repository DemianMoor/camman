-- Enable RLS on the new registry tables.
ALTER TABLE public.affiliate_networks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- affiliate_networks policies (manager+ for CUD; soft-delete only).
CREATE POLICY "affiliate_networks_select_own_org"
  ON public.affiliate_networks
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "affiliate_networks_insert_manager_or_higher"
  ON public.affiliate_networks
  FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = affiliate_networks.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "affiliate_networks_update_manager_or_higher"
  ON public.affiliate_networks
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = affiliate_networks.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = affiliate_networks.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- No DELETE policy for affiliate_networks — archiving via status='archived'.

-- offers policies (manager+ for CUD; soft-delete only).
CREATE POLICY "offers_select_own_org"
  ON public.offers
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "offers_insert_manager_or_higher"
  ON public.offers
  FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = offers.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "offers_update_manager_or_higher"
  ON public.offers
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = offers.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = offers.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- No DELETE policy for offers — archiving via status='archived'.
