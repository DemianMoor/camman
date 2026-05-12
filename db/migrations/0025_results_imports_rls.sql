-- RLS for stage results import surface.
-- mappings  → operator-level CRUD (manager+ for delete)
-- imports   → operator-level create/update (the revert action sets reverted_at).
--             No delete policy at all — imports are permanent audit records.
-- rows      → read-only to users; writes happen only via the server's
--             service-role connection during the import / revert paths.
--             Mirrors campaign_audience_pool.

ALTER TABLE public.result_import_mappings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stage_results_imports ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stage_result_rows ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ============ result_import_mappings ============

CREATE POLICY "mappings_select_own_org"
  ON public.result_import_mappings FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "mappings_insert_operator_or_higher"
  ON public.result_import_mappings FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = result_import_mappings.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "mappings_update_operator_or_higher"
  ON public.result_import_mappings FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = result_import_mappings.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = result_import_mappings.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "mappings_delete_manager_or_higher"
  ON public.result_import_mappings FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = result_import_mappings.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- ============ stage_results_imports ============

CREATE POLICY "imports_select_own_org"
  ON public.stage_results_imports FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "imports_insert_operator_or_higher"
  ON public.stage_results_imports FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = stage_results_imports.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "imports_update_operator_or_higher"
  ON public.stage_results_imports FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = stage_results_imports.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = stage_results_imports.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

-- ============ stage_result_rows ============
-- Read-only to users; the import / revert paths run via the server's
-- service-role connection. No insert/update/delete policies.

CREATE POLICY "rows_select_own_org"
  ON public.stage_result_rows FOR SELECT
  USING (org_id = public.current_org_id());
