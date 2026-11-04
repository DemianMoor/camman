-- 0232: Leads count as Registrations in reports; drip daily results get Leads.
--
-- Owner ruling 2026-11-04. Two additive changes, both inert until the code that
-- reads them deploys.
--
-- 1. event_types.counts_as_registration — REPORTING ONLY.
--    A type with this flag is counted inside the Registrations column (the
--    retarget-signal type's count, rate, pending and Reg->Purchase %), and its
--    own count / rate / pending columns are hidden. Its money columns stay.
--    Set on the `lead` type in every org that has one.
--
--    ⚠️ It does NOT make a contact "registered" for texting. The Registered
--    lane, campaign tiers and drip lifecycle read is_retarget_signal through
--    RETARGET_EVENT_TYPE_IDS (lib/sale-attribution.ts) and never this column.
--    Guard: scripts/test-lead-not-registered-lane.ts.
--
-- 2. drip_daily_rollup.leads / lead_revenue — the drip Daily results' Leads
--    columns: conversions of a retarget-signal or counts_as_registration type
--    (pending + approved), and their approved revenue. lead_revenue is a
--    breakdown of `revenue`, never added to it. The constraints are re-created
--    to cover the new columns (a lead row of the rollup carries no stage
--    counters). Existing rows read 0 until the attended rollup refill.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.event_types
  ADD COLUMN IF NOT EXISTS counts_as_registration boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE public.event_types SET counts_as_registration = true
WHERE key = 'lead' AND counts_as_registration = false;
--> statement-breakpoint
ALTER TABLE public.drip_daily_rollup
  ADD COLUMN IF NOT EXISTS leads integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lead_revenue numeric(12,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.drip_daily_rollup DROP CONSTRAINT IF EXISTS drip_daily_rollup_nonneg;
--> statement-breakpoint
ALTER TABLE public.drip_daily_rollup ADD CONSTRAINT drip_daily_rollup_nonneg CHECK (
  leads_admitted >= 0 AND admitted >= 0 AND admitted_carried >= 0
  AND admitted_carried <= admitted
  AND first_sends >= 0 AND followup_sends >= 0 AND dlr_sent >= 0
  AND delivered >= 0 AND delivered <= dlr_sent
  AND clicks >= 0 AND opt_outs >= 0 AND sales >= 0 AND leads >= 0
);
--> statement-breakpoint
ALTER TABLE public.drip_daily_rollup DROP CONSTRAINT IF EXISTS drip_daily_rollup_row_kind;
--> statement-breakpoint
ALTER TABLE public.drip_daily_rollup ADD CONSTRAINT drip_daily_rollup_row_kind CHECK (
  CASE WHEN stage_id IS NULL
    THEN first_sends = 0 AND followup_sends = 0 AND dlr_sent = 0 AND delivered = 0
         AND clicks = 0 AND opt_outs = 0 AND sales = 0 AND revenue = 0 AND send_cost = 0
         AND leads = 0 AND lead_revenue = 0
         AND latency_hist IS NULL
    ELSE leads_admitted = 0 AND admitted = 0 AND admitted_carried = 0
  END
);
