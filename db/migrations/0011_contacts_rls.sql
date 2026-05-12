-- Enable RLS on contacts.
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- contacts policies. Note: uploading contacts is an OPERATOR-level action
-- (different from registry entities, which require manager+). Hard delete is
-- a manager+ permission and is not exposed via RLS — it's routed through the
-- privileged Drizzle connection that bypasses RLS.

CREATE POLICY "contacts_select_own_org"
  ON public.contacts
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "contacts_insert_operator_or_higher"
  ON public.contacts
  FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = contacts.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "contacts_update_operator_or_higher"
  ON public.contacts
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = contacts.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = contacts.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

-- No DELETE policy. Hard delete is manager+ and routed through the privileged
-- Drizzle connection (server-side, RLS-bypassing).
