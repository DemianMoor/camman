-- Migration 0208: drip_daily_rollup — day-by-day cells for the drip campaign
-- "Daily results" tab (spec docs/superpowers/specs/2026-10-12-drip-daily-results-design.md).
--
-- WHY. The tab must load from pre-aggregated cells, never from raw stage_sends
-- at page load, and the cells must outlive a future stage_sends retention
-- DELETE (card 869enz8ge) for drip stages.
--
-- GRAIN. One row per (campaign, basis, ET day, stage, partner key):
--   basis 'activity' — day_et = the ET day each event happened (sent_at,
--                      clicked_at, opt-out arrival, conversion detection, …)
--   basis 'cohort'   — day_et = the ET day the lead was ADMITTED (routed_at);
--                      the row holds everything those leads did since.
--   stage_id NULL    — the campaign-level LEAD row (admissions have no stage).
--   partner_key_id NULL on a stage row — sends that reach no non-sandbox lead,
--                      kept so a stage's cells sum to all of its sends.
-- Tier is NOT a key: it is a function of the stage (behavioral_tier +
-- parent_stage_id) and is joined at read time.
--
-- ADDITIVE COUNTERS ONLY. Every ratio (Delivered %, CTR, Conv %, ROI, …) is
-- computed at read time from summed cells; the lead-to-send median from summed
-- histograms. Lookup cost is NOT stored: it is admitted × the calibrated rate
-- at read time, exactly as the partner report prices it.
--
-- FKs. stage_id and partner_key_id are NO ACTION (owner asked for "not SET
-- NULL": a SET NULL would fold a deleted stage's cells into the NULL lead row
-- and a deleted key's into the Unattributed bucket under NULLS NOT DISTINCT).
-- NO ACTION rather than RESTRICT because RESTRICT is checked immediately and
-- would refuse a whole-campaign cascade that reaches a stage before its cells;
-- NO ACTION checks at end of statement, after campaign_id's CASCADE has removed
-- them. A lone stage/key delete that would orphan cells is still refused
-- (deleteStage already maps that 23503 to its 409). Same choice as 0197.
--
-- WRITER. Only the drip-daily-rollup cron and the one-off backfill script.
--
-- Also: org_settings.drip_daily_results_enabled — the tab's dark-ship flag.
-- Additive only.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.drip_daily_rollup (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id integer NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  basis text NOT NULL,
  day_et date NOT NULL,
  stage_id integer REFERENCES public.campaign_stages(id) ON DELETE NO ACTION,
  partner_key_id integer REFERENCES public.partner_keys(id) ON DELETE NO ACTION,
  -- lead row (stage_id IS NULL)
  leads_admitted integer NOT NULL DEFAULT 0,   -- activity: admitted leads by their RECEIVED day
  admitted integer NOT NULL DEFAULT 0,         -- by admission day (activity) / the cohort (cohort)
  admitted_carried integer NOT NULL DEFAULT 0, -- of `admitted`, carried_days > 0
  -- stage rows (stage_id IS NOT NULL)
  first_sends integer NOT NULL DEFAULT 0,
  followup_sends integer NOT NULL DEFAULT 0,
  dlr_sent integer NOT NULL DEFAULT 0,         -- sends on DLR-capable providers (Delivered % denominator)
  delivered integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,           -- clean click ROWS (partner-report definition)
  opt_outs integer NOT NULL DEFAULT 0,
  sales integer NOT NULL DEFAULT 0,
  revenue numeric(12,4) NOT NULL DEFAULT 0,    -- approved only
  send_cost numeric(12,4) NOT NULL DEFAULT 0,  -- sends at rate + opt-outs at the answered send's rate
  latency_hist integer[],                      -- first sends: lead-to-send histogram (fixed buckets in code)
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drip_daily_rollup_basis_check CHECK (basis IN ('activity', 'cohort')),
  CONSTRAINT drip_daily_rollup_nonneg CHECK (
    leads_admitted >= 0 AND admitted >= 0 AND admitted_carried >= 0
    AND admitted_carried <= admitted
    AND first_sends >= 0 AND followup_sends >= 0 AND dlr_sent >= 0
    AND delivered >= 0 AND delivered <= dlr_sent
    AND clicks >= 0 AND opt_outs >= 0 AND sales >= 0
  ),
  -- A lead row carries only lead counters; a stage row only stage counters.
  CONSTRAINT drip_daily_rollup_row_kind CHECK (
    CASE WHEN stage_id IS NULL
      THEN first_sends = 0 AND followup_sends = 0 AND dlr_sent = 0 AND delivered = 0
           AND clicks = 0 AND opt_outs = 0 AND sales = 0 AND revenue = 0 AND send_cost = 0
           AND latency_hist IS NULL
      ELSE leads_admitted = 0 AND admitted = 0 AND admitted_carried = 0
    END
  ),
  -- Also the read path: WHERE campaign_id = $1 AND basis = $2 AND day_et BETWEEN …
  CONSTRAINT drip_daily_rollup_cell_uniq
    UNIQUE NULLS NOT DISTINCT (campaign_id, basis, day_et, stage_id, partner_key_id)
);
--> statement-breakpoint
-- The FK side of the NO ACTION checks (a stage / key delete probes these).
CREATE INDEX IF NOT EXISTS drip_daily_rollup_stage_idx
  ON public.drip_daily_rollup (stage_id) WHERE stage_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS drip_daily_rollup_partner_key_idx
  ON public.drip_daily_rollup (partner_key_id) WHERE partner_key_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.drip_daily_rollup ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Read-only to members of the org. No write policy: the refresh job is the
-- only writer and runs on the server's own connection.
DROP POLICY IF EXISTS "drip_daily_rollup_select_own_org" ON public.drip_daily_rollup;
--> statement-breakpoint
CREATE POLICY "drip_daily_rollup_select_own_org"
  ON public.drip_daily_rollup FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS drip_daily_results_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
COMMENT ON COLUMN public.org_settings.drip_daily_results_enabled IS
  'Drip campaign Daily results tab (0208): show the tab + serve its API. Off = hidden; the rollup job runs regardless.';
