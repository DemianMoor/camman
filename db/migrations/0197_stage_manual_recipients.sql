-- 0197 — stage_manual_recipients (Task 3 §4b, task T2b; owner-approved 2026-10-02).
--
-- WHAT IT IS. Who a stage's CSV export went to, and when the stage was marked
-- 'sent'. A manual send happens outside the drain and writes no stage_sends
-- rows, so this is the only record that those contacts were texted. Read by the
-- "Texted in the last…" segment rule and its nightly ground truth. NOT read by
-- reports, breakers or the engagement job; stage_sends is untouched.
--
-- ⚠️ stage_id is ON DELETE NO ACTION, deliberately NOT cascade (owner, 10-02):
-- deleting a stage must never erase the record that its contacts were texted.
-- deleteStage() removes only UNMARKED rows (sent_at NULL) in the same statement
-- and refuses a stage with marked ones; any other path that deletes such a
-- stage (or its campaign) fails with a foreign-key error instead of erasing
-- them. An organization delete still works: org_id cascades, and a NO ACTION
-- check runs at the end of the statement, after the cascade.
--
-- ADDITIVE ONLY: a new empty table. No existing table changes.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.stage_manual_recipients (
  org_id      UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  stage_id    INTEGER     NOT NULL REFERENCES public.campaign_stages(id) ON DELETE NO ACTION,
  contact_id  UUID        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  exported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (stage_id, contact_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stage_manual_recipients_org_sent_idx
  ON public.stage_manual_recipients (org_id, sent_at) INCLUDE (contact_id)
  WHERE sent_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.stage_manual_recipients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "stage_manual_recipients_select_own_org" ON public.stage_manual_recipients;
--> statement-breakpoint
CREATE POLICY "stage_manual_recipients_select_own_org"
  ON public.stage_manual_recipients FOR SELECT
  USING (org_id = public.current_org_id());
