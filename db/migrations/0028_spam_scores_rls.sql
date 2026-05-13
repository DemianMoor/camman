-- RLS for spam_scores.
-- Read: any member of the org.
-- Insert: operator+ (consistent with `creatives.create` / the "scoring is a
-- write action that costs money" framing — viewers can read history but
-- can't drive new scores).
-- No UPDATE/DELETE policies — scores are append-only history.

ALTER TABLE public.spam_scores ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "spam_scores_select_own_org"
  ON public.spam_scores FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "spam_scores_insert_operator_or_higher"
  ON public.spam_scores FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = spam_scores.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
