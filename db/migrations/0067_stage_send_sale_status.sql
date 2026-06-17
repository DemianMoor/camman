-- Migration 0067: per-recipient sale attribution columns on stage_sends.
--
-- Maps Keitaro SALES back to the individual phone number that received the SMS.
-- The per-recipient customer id is stage_sends.id (= links.send_token), which
-- rides into Keitaro as the `sub_id1` URL param (appended at redirect time, see
-- lib/links/resolve-click.ts) and comes back on the `sub_id_1` slot of every
-- conversion. A new poll (lib/keitaro/poll-conversions.ts) reads Keitaro's
-- conversions/log, matches sub_id_1 -> stage_sends.id, and stamps these columns.
--
-- Model — ONE sale per recipient, latest sale wins (accepted scope). A recipient
-- with multiple distinct sale conversions reflects only the most recent one;
-- sale_revenue is that conversion's revenue, NOT a cumulative sum. The documented
-- upgrade path for cumulative/repeat-sale tracking is a separate append-only
-- `keitaro_conversions` ledger keyed on the Keitaro conversion id, with these
-- columns becoming a derived rollup. Not built here.
--
-- keitaro_conversion_id is the dedup key: re-applying the same conversion across
-- overlapping rolling poll windows is a no-op once the column is populated.
--
-- Tracked sends only: manual-mode rows mint no link and reach no redirect, so
-- they never carry a sub_id1 and these columns stay NULL for them (expected).
--
-- Non-destructive: four nullable columns + one CHECK + one partial index. No
-- backfill, no rewrite. Reversible by dropping the columns.

ALTER TABLE stage_sends
  ADD COLUMN sale_status           TEXT,
  ADD COLUMN sale_revenue          NUMERIC(12, 4),
  ADD COLUMN converted_at          TIMESTAMPTZ,
  ADD COLUMN keitaro_conversion_id TEXT;

ALTER TABLE stage_sends ADD CONSTRAINT stage_sends_sale_status_check
  CHECK (sale_status IS NULL OR sale_status IN ('lead', 'sale', 'rejected'));

-- "Show me the conversions" reads only ever want the stamped rows.
CREATE INDEX stage_sends_sale_status_idx
  ON stage_sends (sale_status)
  WHERE sale_status IS NOT NULL;
