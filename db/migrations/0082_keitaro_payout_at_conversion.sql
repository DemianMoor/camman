-- Migration 0082: stamp the per-conversion payout onto each keitaro_stage_results
-- row so it can never be retro-changed by a later CPA edit on the offer.
--
-- keitaro_stage_results.revenue already holds the REAL summed conversion revenue
-- pulled from Keitaro at sync time (and is the revenue source of truth). This
-- column records the per-conversion RATE for the row (= revenue / sales), frozen
-- at sync. The Keitaro poll writes it going forward (lib/keitaro/poll.ts).
--
-- Backfill: per-conversion payout = revenue / NULLIF(sales, 0); NULL when the row
-- has 0 sales (no conversion to price). Idempotent: only fills rows still NULL.

ALTER TABLE public.keitaro_stage_results
  ADD COLUMN IF NOT EXISTS payout_at_conversion numeric(12, 4);
--> statement-breakpoint

UPDATE public.keitaro_stage_results
SET payout_at_conversion = round(revenue / NULLIF(sales, 0), 4)
WHERE sales > 0 AND payout_at_conversion IS NULL;
