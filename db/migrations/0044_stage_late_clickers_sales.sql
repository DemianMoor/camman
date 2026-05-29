-- Stage results: split clickers into day-1 vs late, and add manual
-- checkout-click + sales tracking (with a snapshotted offer payout for
-- revenue/ROI).
--
-- campaign_stages:
--   late_click_count       — clicks from follow-up ("late") clicker reports,
--                            deduped against all clickers already recorded
--                            for the stage. The existing click_count keeps
--                            its meaning and is surfaced as "Clicker 1st Day".
--   checkout_click_count   — manual-only (no CSV path yet).
--   sales_count            — manual-only (no CSV path yet).
--   sales_payout_each      — offer CPA payout snapshotted when the sales
--                            count was last entered; powers revenue/ROI and
--                            freezes the rate "on the date the sale was
--                            mapped". NULL when there are no sales.
--
-- stage_results_imports:
--   late_clickers_added    — clicks added by a clicker_phase='late' import;
--                            kept separate so revert undoes late_click_count.
--   clicker_phase          — 'day1' (normal full import) or 'late' (clicker-
--                            only follow-up). NULL on legacy rows = day1.

ALTER TABLE "campaign_stages"
  ADD COLUMN "late_click_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "checkout_click_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "sales_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "sales_payout_each" numeric(12, 4);

ALTER TABLE "stage_results_imports"
  ADD COLUMN "late_clickers_added" integer NOT NULL DEFAULT 0,
  ADD COLUMN "clicker_phase" text;

ALTER TABLE "stage_results_imports"
  ADD CONSTRAINT "stage_results_imports_clicker_phase_check"
  CHECK ("clicker_phase" IS NULL OR "clicker_phase" IN ('day1', 'late'));
