-- Enable RLS on the 3 new tables.
ALTER TABLE public.segments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.segment_contacts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.segment_stats ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ============ segments ============
-- Creating/editing segments is administrative → manager+.
-- DELETE is exposed via API only (manager+); no DELETE policy here because
-- the API path always runs via service role (postgres-js bypasses RLS for
-- our app server). The RLS policy set is the same defense-in-depth shape
-- as elsewhere in the registry: SELECT/INSERT/UPDATE only.

CREATE POLICY "segments_select_own_org"
  ON public.segments FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "segments_insert_manager_or_higher"
  ON public.segments FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = segments.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "segments_update_manager_or_higher"
  ON public.segments FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = segments.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = segments.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "segments_delete_manager_or_higher"
  ON public.segments FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = segments.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

-- ============ segment_contacts ============
-- Adding/removing contacts in a segment is operational → operator+.

CREATE POLICY "segment_contacts_select_own_org"
  ON public.segment_contacts FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "segment_contacts_insert_operator_or_higher"
  ON public.segment_contacts FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = segment_contacts.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "segment_contacts_delete_operator_or_higher"
  ON public.segment_contacts FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = segment_contacts.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

-- ============ segment_stats ============
-- Read-only to users; writes happen only through SECURITY DEFINER triggers
-- or via the application's service-role connection (the refresh-stats API).

CREATE POLICY "segment_stats_select_own_org"
  ON public.segment_stats FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

-- ============ Trigger: keep segment_stats.total_count in sync ============
-- Fires per row on segment_contacts INSERT/DELETE. The SELECT COUNT(*) is fast
-- because of the (segment_id, contact_id) primary key. If 5000-row uploads
-- show this as a bottleneck, swap to a per-statement trigger that aggregates
-- the OLD/NEW transition tables and bumps the counter by the delta.
CREATE OR REPLACE FUNCTION public.refresh_segment_total_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected_segment_id INTEGER;
BEGIN
  affected_segment_id := COALESCE(NEW.segment_id, OLD.segment_id);

  INSERT INTO public.segment_stats (segment_id, org_id, total_count, updated_at)
  SELECT affected_segment_id,
         s.org_id,
         (SELECT COUNT(*) FROM public.segment_contacts WHERE segment_id = affected_segment_id),
         NOW()
  FROM public.segments s
  WHERE s.id = affected_segment_id
  ON CONFLICT (segment_id) DO UPDATE
    SET total_count = EXCLUDED.total_count,
        updated_at = NOW();

  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS segment_contacts_after_change ON public.segment_contacts;--> statement-breakpoint
CREATE TRIGGER segment_contacts_after_change
  AFTER INSERT OR DELETE ON public.segment_contacts
  FOR EACH ROW EXECUTE FUNCTION public.refresh_segment_total_count();
--> statement-breakpoint

-- ============ Trigger: initialize segment_stats row on segment creation ============
CREATE OR REPLACE FUNCTION public.initialize_segment_stats()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.segment_stats (segment_id, org_id, total_count, opt_out_count, opt_in_count, clicker_count)
  VALUES (NEW.id, NEW.org_id, 0, 0, 0, 0);
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS segments_after_insert ON public.segments;--> statement-breakpoint
CREATE TRIGGER segments_after_insert
  AFTER INSERT ON public.segments
  FOR EACH ROW EXECUTE FUNCTION public.initialize_segment_stats();
