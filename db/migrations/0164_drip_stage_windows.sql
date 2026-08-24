-- Migration 0164: drip stage daily windows (Drip Phase 5).
--
-- A drip stage is not a one-shot scheduled send; it is a DAILY TIME WINDOW in
-- ET. A lead gets exactly ONE first-send — from the stage whose window covers
-- its arrival, or the next window to open.
--
-- ⚠️ MINUTES PAST ET MIDNIGHT, not `time`. The comparison the scheduler makes is
-- "where does this instant fall in the ET wall-clock day", which is arithmetic
-- on a local clock with no date attached. A `time` column would invite a
-- timestamp comparison that silently drags a date and a UTC offset into it —
-- the same class of bug that made TextHub's received_at read six hours wrong.
-- smallint 0..1439 has exactly the domain the rule has.
--
-- ⚠️ ALL THREE COLUMNS ARE NULLABLE AND NULL ON EVERY EXISTING ROW. A regular
-- stage has no window, and nothing about this migration changes what any
-- existing stage does. The CHECKs are written so that "all three NULL" is
-- always valid — an additive column whose CHECK rejects the existing shape is
-- not additive.
--
-- ⚠️ WINDOWS MAY NOT OVERLAP **OR TOUCH**, per the spec: 09:30–14:00 followed by
-- 14:00–18:30 is an ERROR, because the boundary minute belongs to both. The
-- operator wants 13:59 or 14:01. That rule spans MULTIPLE ROWS so it cannot be
-- a CHECK; it is enforced server-side on save and asserted in the write test.
-- What the CHECK here can enforce is the single-row half: end strictly after
-- start, and both inside the day.
--
-- ADDITIVE. No backfill, no data change, no index on stage_sends (G10).

ALTER TABLE public.campaign_stages
  ADD COLUMN window_start_min smallint;
--> statement-breakpoint

ALTER TABLE public.campaign_stages
  ADD COLUMN window_end_min smallint;
--> statement-breakpoint

-- The activation toggle. NULL for regular stages; a drip stage that is not
-- active is configured but does not fire.
ALTER TABLE public.campaign_stages
  ADD COLUMN drip_active boolean;
--> statement-breakpoint

ALTER TABLE public.campaign_stages
  ADD CONSTRAINT campaign_stages_drip_window_check CHECK (
    -- regular stage: no window at all
    (window_start_min IS NULL AND window_end_min IS NULL)
    OR (
      window_start_min IS NOT NULL AND window_end_min IS NOT NULL
      AND window_start_min >= 0    AND window_start_min <= 1439
      AND window_end_min   >= 1    AND window_end_min   <= 1440
      -- Strictly after: a zero-length window would match nothing and look like
      -- a configured stage that silently never fires.
      AND window_end_min > window_start_min
    )
  );
--> statement-breakpoint

-- The scheduler's per-campaign stage scan: active drip stages, ordered by window.
CREATE INDEX campaign_stages_drip_window_idx
  ON public.campaign_stages (campaign_id, window_start_min)
  WHERE drip_active IS TRUE;
