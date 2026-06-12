-- Keitaro 5-minute poll: per-stage daily aggregate of clicks + conversions +
-- revenue pulled from Keitaro's Admin API (POST /admin_api/v1/report/build,
-- grouped by day + sub_id_3). In CamMan, sub_id_3 carries the STAGE tracking id
-- (e.g. 5_14296_051526_1_s2_c42), so each row is one (stage, ET date); a
-- campaign's totals are the SUM across its stages. See lib/keitaro/.
--
-- Idempotent by design: the poll re-reads a rolling multi-day window every 5
-- minutes and UPSERTs the current cumulative totals (last-write-wins on
-- (org_id, stage_id, stat_date)), so re-polling never double-counts. Late
-- conversions attach to earlier clicks and overwrite the prior row in place.
CREATE TABLE public.keitaro_stage_results (
  id                serial PRIMARY KEY,
  org_id            uuid    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id       integer NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  stage_id          integer NOT NULL REFERENCES public.campaign_stages(id) ON DELETE CASCADE,
  stage_tracking_id text    NOT NULL,
  stat_date         date    NOT NULL,
  raw_clicks        integer NOT NULL DEFAULT 0,
  clean_clicks      integer NOT NULL DEFAULT 0,
  checkouts         integer NOT NULL DEFAULT 0,
  sales             integer NOT NULL DEFAULT 0,
  revenue           numeric(12, 4) NOT NULL DEFAULT 0,
  cost              numeric(12, 4) NOT NULL DEFAULT 0,
  epc               numeric(12, 4) NOT NULL DEFAULT 0,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT keitaro_stage_results_stage_date_uniq UNIQUE (org_id, stage_id, stat_date)
);
--> statement-breakpoint

CREATE INDEX keitaro_stage_results_campaign_date_idx
  ON public.keitaro_stage_results (campaign_id, stat_date);
--> statement-breakpoint
CREATE INDEX keitaro_stage_results_org_id_idx ON public.keitaro_stage_results (org_id);
--> statement-breakpoint

-- RLS: org-scoped reads for the CRM results view. Writes happen via the app's
-- privileged connection in the cron poll handler, so there is no authenticated
-- write policy (mirrors campaign_events / send_circuit_events).
ALTER TABLE public.keitaro_stage_results ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "keitaro_stage_results_select_own_org"
  ON public.keitaro_stage_results FOR SELECT
  USING (org_id = public.current_org_id());
