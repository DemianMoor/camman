-- Migration 0169: tier DETECTION timestamps (Drip Phase 6, ruling D1).
--
-- ⚠️ WHY EXISTING COLUMNS CANNOT SERVE. offer_reached_at and converted_at are
-- stamped from KEITARO'S EVENT DATETIME, not from when we learned of it —
-- lib/keitaro/poll-offer-reaches.ts and poll-conversions.ts both write
-- (v.dt || ' ' || CAMPAIGN_TIMEZONE)::timestamptz. The pollers run every 15
-- minutes and the network's postback lag is measured in hours: offer reach p50
-- 146 min, conversion p50 219 min over the last 30 days.
--
-- So a follow-up timer defined as "time since detection" CANNOT key off them.
-- At p50, a 60-minute Offer timer computed from offer_reached_at is ALREADY
-- EXPIRED at the moment of detection — the operator sets 60 minutes and the
-- follow-up fires instantly on the next tick. These columns record when we
-- LEARNED, which is the only clock a timer can honestly run from.
--
-- ⚠️ TIER 1 NEEDS NO EQUIVALENT. clicks has no clicked_at in its INSERT
-- (lib/links/resolve-click.ts) and takes the column default now(), so a click's
-- detection IS its event. Adding a third column "for symmetry" would create a
-- second, redundant definition of a time we already have exactly.
--
-- ⚠️ 3.47M ROWS, AND THIS IS THE TABLE THE SEND PATH READS TWICE A MINUTE.
-- Two nullable columns with NO DEFAULT and NO index is a catalogue-only change
-- in PG 11+ (no table rewrite, no full-table lock beyond a brief ACCESS
-- EXCLUSIVE on the catalogue). No index is added: nothing scans BY detection
-- time — the timer reads these columns for rows it has already located by
-- journey, so an index would cost writes on every poll and buy nothing.
--
-- ADDITIVE. NULL on every existing row. A NULL detection timestamp means
-- "detected before this migration, or not yet detected"; the timer treats it as
-- not-yet-detected, which is the fail-toward-not-sending direction.

ALTER TABLE public.stage_sends
  ADD COLUMN offer_reached_detected_at timestamptz;
--> statement-breakpoint

ALTER TABLE public.stage_sends
  ADD COLUMN converted_detected_at timestamptz;
