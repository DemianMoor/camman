-- Enable RLS on the new tables.
ALTER TABLE public.sms_providers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.provider_phones ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- sms_providers policies (manager+ for CUD; soft-delete only).
CREATE POLICY "sms_providers_select_own_org"
  ON public.sms_providers
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "sms_providers_insert_manager_or_higher"
  ON public.sms_providers
  FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = sms_providers.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "sms_providers_update_manager_or_higher"
  ON public.sms_providers
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = sms_providers.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = sms_providers.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- provider_phones policies (manager+ for CUD; soft-delete only).
CREATE POLICY "provider_phones_select_own_org"
  ON public.provider_phones
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "provider_phones_insert_manager_or_higher"
  ON public.provider_phones
  FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = provider_phones.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "provider_phones_update_manager_or_higher"
  ON public.provider_phones
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = provider_phones.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = provider_phones.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- No DELETE policies — archive via status.
