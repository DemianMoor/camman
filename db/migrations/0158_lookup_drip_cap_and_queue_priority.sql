-- Migration 0158: drip lookup sub-cap, balance floor, and lookup_queue priority
-- (Drip Phase 3).
--
-- ============================================================================
-- lookup_settings.drip_daily_cap  +  lookup_settings.balance_floor_usd
-- ============================================================================
--
-- ⚠️ TWO DIFFERENT DAY BOUNDARIES NOW LIVE IN ONE FLOW, deliberately (ruled).
--   * lookup_daily_cap  — the ACCOUNT-GLOBAL cap, anchored to WARSAW midnight
--     (lib/telnyx/daily-cap.ts). Untouched by this migration.
--   * drip_daily_cap    — drip's own sub-cap, counted per ET CALENDAR DAY, like
--     every other drip-facing number.
--
-- Warsaw midnight is 18:00 ET — measured, not assumed — which is INSIDE the
-- 8AM-9PM ET drip window. So one ET drip day straddles two global cap days, and
-- the global cap can exhaust mid-afternoon ET and refill at 6PM, which looks
-- exactly like an outage. Anything surfacing either number must say WHICH day it
-- means; they will not agree.
--
-- balance_floor_usd backs the top-up alert. The formula is
--     alert when balance < GREATEST(7 x avg_daily_spend_7d, balance_floor_usd)
-- ⚠️ The floor is not belt-and-braces, it is the ONLY thing that works at
-- launch: 7-day lookup spend is currently $0.00 (no batches since 2026-08-10),
-- so the historical half evaluates to $0 and the alert would never fire —
-- precisely when drip first needs it. Spend stays $0 right up until the instant
-- drip turns on. Default $50; the live Telnyx balance when this was written was
-- $2.47, so it fires immediately, which is correct.
--
-- ============================================================================
-- lookup_queue.priority
-- ============================================================================
--
-- ⚠️ HEAD-OF-LINE BLOCKING, MEASURED. lookup_queue has no org_id — it is
-- account-global — and the worker claims `ORDER BY created_at, id`. A bulk
-- upload enqueued before a drip lead puts that lead behind the ENTIRE batch:
-- observed p50 42 min and p95 111 min across 259,863 lookups from batches of
-- 19,713-229,867 numbers. Against a "1-2 minute reaction" target that is fatal,
-- and it is the same failure class as the scheduled-drain head-of-line incident.
--
-- The new claim order is `priority DESC, created_at, id`. DEFAULT 0 means every
-- existing row and every existing caller keeps EXACTLY today's ordering — with
-- one distinct priority value in the table, `priority DESC` is a no-op and rows
-- order by created_at, id as before. Only drip enqueues above 0.
--
-- ADDITIVE with behaviour-preserving defaults. No backfill.

ALTER TABLE public.lookup_settings
  ADD COLUMN drip_daily_cap integer NOT NULL DEFAULT 50000;
--> statement-breakpoint

ALTER TABLE public.lookup_settings
  ADD COLUMN balance_floor_usd numeric(10, 2) NOT NULL DEFAULT 50.00;
--> statement-breakpoint

ALTER TABLE public.lookup_settings
  ADD CONSTRAINT lookup_settings_drip_daily_cap_check CHECK (drip_daily_cap >= 0);
--> statement-breakpoint

ALTER TABLE public.lookup_settings
  ADD CONSTRAINT lookup_settings_balance_floor_check CHECK (balance_floor_usd >= 0);
--> statement-breakpoint

-- Higher runs first. 0 = today's behaviour for every existing row.
ALTER TABLE public.lookup_queue
  ADD COLUMN priority smallint NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Matches the new claim order exactly, and partial on the only status the
-- claim ever scans. The existing pending index is left in place — it still
-- serves the depth counters, which do not order.
CREATE INDEX lookup_queue_priority_pending_idx
  ON public.lookup_queue (priority DESC, created_at, id)
  WHERE status = 'pending';
