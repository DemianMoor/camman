-- current_org_id() helper.
-- SECURITY DEFINER so RLS on org_members doesn't recursively gate this lookup.
CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id
  FROM public.org_members
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;
--> statement-breakpoint

-- Enable RLS on all four tables.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.org_members ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- organizations policies.
CREATE POLICY "organizations_select_own"
  ON public.organizations
  FOR SELECT
  USING (id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "organizations_update_owner"
  ON public.organizations
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = organizations.id
        AND om.user_id = auth.uid()
        AND om.role = 'owner'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = organizations.id
        AND om.user_id = auth.uid()
        AND om.role = 'owner'
    )
  );
--> statement-breakpoint

-- org_members policies.
CREATE POLICY "org_members_select_own_org"
  ON public.org_members
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "org_members_insert_by_admins"
  ON public.org_members
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = org_members.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin')
    )
  );
--> statement-breakpoint

CREATE POLICY "org_members_update_by_owners"
  ON public.org_members
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = org_members.org_id
        AND om.user_id = auth.uid()
        AND om.role = 'owner'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = org_members.org_id
        AND om.user_id = auth.uid()
        AND om.role = 'owner'
    )
  );
--> statement-breakpoint

-- DELETE: admins/owners may remove members, except the last owner cannot
-- remove themselves (owner self-protection).
CREATE POLICY "org_members_delete_by_admins_except_last_owner"
  ON public.org_members
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = org_members.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin')
    )
    AND NOT (
      org_members.user_id = auth.uid()
      AND org_members.role = 'owner'
      AND (
        SELECT count(*)
        FROM public.org_members om2
        WHERE om2.org_id = org_members.org_id
          AND om2.role = 'owner'
      ) <= 1
    )
  );
--> statement-breakpoint

-- invites policies.
CREATE POLICY "invites_select_own_org"
  ON public.invites
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "invites_insert_by_admins"
  ON public.invites
  FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = invites.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin')
    )
  );
--> statement-breakpoint

CREATE POLICY "invites_delete_by_admins"
  ON public.invites
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = invites.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin')
    )
  );
--> statement-breakpoint

-- brands policies.
CREATE POLICY "brands_select_own_org"
  ON public.brands
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "brands_insert_manager_or_higher"
  ON public.brands
  FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = brands.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "brands_update_manager_or_higher"
  ON public.brands
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = brands.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = brands.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- No DELETE policy for brands — archiving via status='archived' is the supported workflow.

-- New-user trigger: auto-create an organization and make the new user its owner.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org_id uuid;
  user_display_name text;
BEGIN
  user_display_name := COALESCE(
    NEW.raw_user_meta_data->>'display_name',
    split_part(NEW.email, '@', 1)
  );

  INSERT INTO public.organizations (name)
  VALUES (user_display_name || '''s Organization')
  RETURNING id INTO new_org_id;

  INSERT INTO public.org_members (user_id, org_id, role)
  VALUES (NEW.id, new_org_id, 'owner');

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;--> statement-breakpoint
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
