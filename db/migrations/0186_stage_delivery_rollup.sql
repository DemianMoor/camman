-- Migration 0186: stage_delivery_rollup — the pre-aggregated Delivered % cells
-- (ClickUp 869f5q5au).
--
-- WHY. The live delivery query (lib/reporting/delivery.ts, queryDeliveryByStage)
-- reads every send in the report window off stage_sends and every receipt
-- received since the window opened. After PR #206 bounded the receipt side, a
-- 1-day window costs ~0.5 s but 7 days is still ~16.5 s and 14 days ~20 s
-- (prod, 2026-09-22): both halves are I/O-bound on Small compute. This table
-- holds the same four counts per (stage, number, send ET day), so a report
-- window is a sum over a few hundred rows — 22–29 ms for 1/7/14 days, measured
-- on a prototype built from prod data.
--
-- GRAIN. One row per (stage_id, provider_phone_id, sent_date_et), where
-- sent_date_et is the SEND's America/New_York calendar day. The day is in the
-- key because 6 of 2,110 stages ever sent straddled ET midnight (all six in the
-- last month); without it those stages could not match the live query, which
-- windows individual sends, whenever a report edge falls between their days.
-- Summing the rows of a day range reproduces the live query's (stage, phone)
-- rows exactly.
--
-- DEFINITIONS are the live query's, computed by the same SQL fragments
-- (terminalCte + DELIVERY_COUNTS in lib/reporting/delivery.ts): txr callback +
-- poll folded per message before the join, lower() on status, delivered wins,
-- no_receipt = NOT (delivered OR undelivered), sent = status 'sent'. Counts are
-- stored for EVERY provider; the DLR_SOURCES capability gate (null, never 0)
-- stays in the read layer, exactly as before.
--
-- WRITER. Only the refresh job (app/api/cron/delivery-rollup) and the one-off
-- backfill script write here. Nothing on stage_sends or the DLR intake path
-- changes. Cells older than 7 ET days are final and never recomputed: 0 of
-- 2.64M terminal receipts ever arrived ≥ 6 days after their send (max 5 d 00:02).
--
-- provider_phone_id mirrors stage_sends.provider_phone_id's FK (ON DELETE SET
-- NULL) so a deleted number degrades the same way in both. The unique key is
-- NULLS NOT DISTINCT so a NULL-number cell is still one cell.
--
-- Additive only: no existing object changes. Lock footprint is the new table's
-- own plus a brief reference lock on each FK target.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.stage_delivery_rollup (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  stage_id integer NOT NULL REFERENCES public.campaign_stages(id) ON DELETE CASCADE,
  provider_phone_id integer REFERENCES public.provider_phones(id) ON DELETE SET NULL,
  sent_date_et date NOT NULL,
  sent integer NOT NULL,
  delivered integer NOT NULL,
  undelivered integer NOT NULL,
  no_receipt integer NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Every row foots, enforced by the database rather than only by
  -- scripts/verify-delivery-grains.ts.
  CONSTRAINT stage_delivery_rollup_foots CHECK (
    sent >= 0 AND delivered >= 0 AND undelivered >= 0 AND no_receipt >= 0
    AND delivered + undelivered + no_receipt = sent
  ),
  CONSTRAINT stage_delivery_rollup_cell_uniq
    UNIQUE NULLS NOT DISTINCT (stage_id, provider_phone_id, sent_date_et)
);
--> statement-breakpoint
-- The report read: WHERE org_id = $1 AND sent_date_et BETWEEN $2 AND $3.
CREATE INDEX IF NOT EXISTS stage_delivery_rollup_org_day_idx
  ON public.stage_delivery_rollup (org_id, sent_date_et);
--> statement-breakpoint
ALTER TABLE public.stage_delivery_rollup ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Read-only to members of the org. No INSERT/UPDATE/DELETE policy: the refresh
-- job is the only writer and runs on the server's own connection.
DROP POLICY IF EXISTS "stage_delivery_rollup_select_own_org" ON public.stage_delivery_rollup;
--> statement-breakpoint
CREATE POLICY "stage_delivery_rollup_select_own_org"
  ON public.stage_delivery_rollup FOR SELECT
  USING (org_id = public.current_org_id());
