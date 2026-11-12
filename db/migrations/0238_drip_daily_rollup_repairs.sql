-- Migration 0238: drip_daily_rollup_repairs — the trail of the nightly
-- reconcile's cohort-click repairs (lib/reporting/drip-daily-rollup-nightly.ts).
--
-- WHY. A cohort cell counts every clean click on its sends' links with no time
-- bound, so a click arriving more than 14 days after the lead was admitted lands
-- in an already-frozen cell (measured 2026-11-12: 22 cells / +39 clicks, all
-- cohort `clicks`, exactly 39 late clicks). The owner chose to repair those
-- cells (option B): the reconcile writes back ONLY the cohort `clicks` counter,
-- ONLY upward, and records each repair here. Anything else that differs still
-- fires the drift alert and is not touched.
--
-- KEY COPIED, NOT FOREIGN-KEYED to stage / partner key: an FK would make this
-- trail block a stage or partner-key delete (drip_daily_rollup itself is
-- NO ACTION on both). campaign_id / org_id cascade with their parents.
--
-- WRITER. Only the drip-daily-rollup cron's reconcile step. Additive only.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.drip_daily_rollup_repairs (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id integer NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  basis text NOT NULL,
  day_et date NOT NULL,
  stage_id integer,
  partner_key_id integer,
  old_clicks integer NOT NULL,
  new_clicks integer NOT NULL,
  unit_key text NOT NULL,
  repaired_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drip_daily_rollup_repairs_basis_check CHECK (basis = 'cohort'),
  CONSTRAINT drip_daily_rollup_repairs_upward CHECK (new_clicks > old_clicks AND old_clicks >= 0)
);
--> statement-breakpoint
-- The nightly guard sums tonight's repairs per org: WHERE org_id = $1 AND repaired_at >= $2.
CREATE INDEX IF NOT EXISTS drip_daily_rollup_repairs_org_at_idx
  ON public.drip_daily_rollup_repairs (org_id, repaired_at);
--> statement-breakpoint
-- The FK side of the campaign cascade.
CREATE INDEX IF NOT EXISTS drip_daily_rollup_repairs_campaign_idx
  ON public.drip_daily_rollup_repairs (campaign_id);
--> statement-breakpoint
ALTER TABLE public.drip_daily_rollup_repairs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Read-only to members of the org. No write policy: the cron is the only writer
-- and runs on the server's own connection.
DROP POLICY IF EXISTS "drip_daily_rollup_repairs_select_own_org" ON public.drip_daily_rollup_repairs;
--> statement-breakpoint
CREATE POLICY "drip_daily_rollup_repairs_select_own_org"
  ON public.drip_daily_rollup_repairs FOR SELECT
  USING (org_id = public.current_org_id());
