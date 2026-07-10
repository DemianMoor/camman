-- Telnyx Number Lookup — batch spend reconciliation. The rate-computed cost proved
-- wrong at calibration (model $1.92 vs $0.75 actually billed — type=carrier is billed
-- flat, no mobile surcharge on this account), so the batch Telegram summary now
-- reports the LEDGER truth (Telnyx balance delta) alongside the rate estimate.
--
-- balance_before_usd: captured by the worker at the start of the first drain pass
-- that touches the batch (it already fetches balance for the guard). balance_after_usd:
-- captured at batch finalize. billed = before - after. Both nullable (balance call may
-- be unavailable). Caveat: the delta is per-run cleanest when one batch drains at a
-- time; overlapping batches share a window.
ALTER TABLE public.lookup_batches
  ADD COLUMN IF NOT EXISTS balance_before_usd numeric(10, 4);
--> statement-breakpoint

ALTER TABLE public.lookup_batches
  ADD COLUMN IF NOT EXISTS balance_after_usd numeric(10, 4);
