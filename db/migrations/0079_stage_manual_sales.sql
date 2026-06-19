-- Migration 0079: per-entry ledger of the operator's MANUAL sales tally, so the
-- date-ranged Reports tab can attribute manual sales to WHEN they were entered.
--
-- campaign_stages.sales_count is a single overwrite-on-save integer with no entry
-- time. Each manual-results save now also writes the signed CHANGE (delta) here,
-- dated to the save. SUM(delta) for a stage == its current sales_count. The report
-- sums deltas whose created_at falls in the selected range and adds them to the
-- Keitaro conversion count. See app/api/campaigns/[campaignId]/stages/[stageId]/
-- manual-results/route.ts and app/api/keitaro/reports/route.ts.
--
-- Backfill: existing sales_count totals predate this ledger and carry no entry
-- date, so seed one row per stage (delta = current sales_count) dated now() —
-- "treat as entered now" (operator's choice). Idempotent guard: only runs when the
-- ledger is empty, so re-applying never double-seeds.

CREATE TABLE public.stage_manual_sales (
  id          serial PRIMARY KEY,
  org_id      uuid NOT NULL,
  campaign_id integer NOT NULL,
  stage_id    integer NOT NULL,
  delta       integer NOT NULL,
  entered_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stage_manual_sales_org_id_organizations_id_fk
    FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT stage_manual_sales_campaign_id_campaigns_id_fk
    FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE,
  CONSTRAINT stage_manual_sales_stage_id_campaign_stages_id_fk
    FOREIGN KEY (stage_id) REFERENCES public.campaign_stages(id) ON DELETE CASCADE
);

CREATE INDEX stage_manual_sales_org_stage_created_idx
  ON public.stage_manual_sales (org_id, stage_id, created_at);

-- Backfill existing manual sales as "entered now" (delta = current total).
INSERT INTO public.stage_manual_sales (org_id, campaign_id, stage_id, delta, entered_by, created_at)
SELECT org_id, campaign_id, id, sales_count, NULL, now()
FROM public.campaign_stages
WHERE sales_count > 0
  AND NOT EXISTS (SELECT 1 FROM public.stage_manual_sales);
