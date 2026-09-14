-- 0179 — campaign_stages.status_set_manually (ClickUp 869evxbgb).
--
-- The system now moves a stage's status by itself in two places (see
-- lib/stages/auto-status.ts): materialization completes ⇒ draft → pending; the
-- prepared send is cancelled ⇒ pending → draft. A status an operator picked by
-- hand must never be overwritten, so every manual status write (the status route
-- and bulk-status) sets this flag and the automatic moves refuse any stage that
-- carries it. Sticky: nothing clears it.
ALTER TABLE public.campaign_stages
  ADD COLUMN IF NOT EXISTS status_set_manually boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Backfill. Until this migration, stage `status` was written only by people (the
-- status route, bulk-status, archive/restore) and every one of those writes set
-- previous_status; stage inserts leave it NULL. So `previous_status IS NOT NULL`
-- means "someone has changed this stage's status" — mark those manual. Only
-- never-touched stages (still on their creation 'draft') get the automation.
-- Read on production 2026-09-14: 1,944 of 1,966 stages touched, 22 never touched.
UPDATE public.campaign_stages
SET status_set_manually = true
WHERE previous_status IS NOT NULL AND status_set_manually = false;
