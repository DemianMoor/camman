-- Enable RLS on all 5 new tables.
ALTER TABLE public.opt_outs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.opt_out_brands ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.opt_out_providers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.opt_ins ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.clickers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Audience-engagement permission model:
--   SELECT: any org member
--   INSERT/UPDATE: operator+ (audience-data ingestion is operator-level)
--   DELETE: manager+ (suppression-data deletion is privileged)
-- DELETE policies exist here (unlike registry entities which soft-delete)
-- because these tables grow unbounded and hard-delete is the cleanup path.

-- ============ opt_outs ============

CREATE POLICY "opt_outs_select_own_org"
  ON public.opt_outs FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "opt_outs_insert_operator_or_higher"
  ON public.opt_outs FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = opt_outs.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "opt_outs_update_operator_or_higher"
  ON public.opt_outs FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = opt_outs.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = opt_outs.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "opt_outs_delete_manager_or_higher"
  ON public.opt_outs FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = opt_outs.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- ============ opt_out_brands (junction) ============
-- Visibility/permissions flow through the parent opt_out's org_id.

CREATE POLICY "opt_out_brands_select_own_org"
  ON public.opt_out_brands FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.opt_outs oo
      WHERE oo.id = opt_out_brands.opt_out_id
        AND oo.org_id = public.current_org_id()
    )
  );
--> statement-breakpoint

CREATE POLICY "opt_out_brands_insert_operator_or_higher"
  ON public.opt_out_brands FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.opt_outs oo
      JOIN public.org_members om ON om.org_id = oo.org_id
      WHERE oo.id = opt_out_brands.opt_out_id
        AND oo.org_id = public.current_org_id()
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "opt_out_brands_delete_manager_or_higher"
  ON public.opt_out_brands FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.opt_outs oo
      JOIN public.org_members om ON om.org_id = oo.org_id
      WHERE oo.id = opt_out_brands.opt_out_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- ============ opt_out_providers (junction) ============

CREATE POLICY "opt_out_providers_select_own_org"
  ON public.opt_out_providers FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.opt_outs oo
      WHERE oo.id = opt_out_providers.opt_out_id
        AND oo.org_id = public.current_org_id()
    )
  );
--> statement-breakpoint

CREATE POLICY "opt_out_providers_insert_operator_or_higher"
  ON public.opt_out_providers FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.opt_outs oo
      JOIN public.org_members om ON om.org_id = oo.org_id
      WHERE oo.id = opt_out_providers.opt_out_id
        AND oo.org_id = public.current_org_id()
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "opt_out_providers_delete_manager_or_higher"
  ON public.opt_out_providers FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.opt_outs oo
      JOIN public.org_members om ON om.org_id = oo.org_id
      WHERE oo.id = opt_out_providers.opt_out_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- ============ opt_ins ============

CREATE POLICY "opt_ins_select_own_org"
  ON public.opt_ins FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "opt_ins_insert_operator_or_higher"
  ON public.opt_ins FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = opt_ins.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "opt_ins_update_operator_or_higher"
  ON public.opt_ins FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = opt_ins.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = opt_ins.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "opt_ins_delete_manager_or_higher"
  ON public.opt_ins FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = opt_ins.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- ============ clickers ============

CREATE POLICY "clickers_select_own_org"
  ON public.clickers FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "clickers_insert_operator_or_higher"
  ON public.clickers FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = clickers.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "clickers_update_operator_or_higher"
  ON public.clickers FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = clickers.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = clickers.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "clickers_delete_manager_or_higher"
  ON public.clickers FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = clickers.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
