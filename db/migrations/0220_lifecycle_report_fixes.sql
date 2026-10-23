-- 0220 — Lifecycle report fixes (2026-10-23 audit). ADDITIVE ONLY.
--
-- lifecycle_day_rollup
--   campaign_kind  'regular' | 'drip'. Drip sends get their own report row
--                  ("Drip") instead of folding into the cohorts, but they are
--                  still stamped, so the column — not the cohort — is what keeps
--                  them apart. Part of the PK: a day can hold a regular 'hot'
--                  cell and a drip 'hot' cell.
--   purchases      purchase EVENTS (pending/approved), next to `sales`, which
--                  stays "sends with ≥1 purchase" (buyers).
--   new_clickers   sends whose human click was the contact's first-ever.
--   cohort         + 'warm_31_60' / 'warm_61_120' (days since the last human
--                  click at send time). 'warm' stays valid for a warm stamp with
--                  no recorded click time.
--
-- stage_send_lifecycle
--   last_click_at  the contact's last human click as known when the stamp was
--                  written (contact_engagement.last_click_at), or replayed from
--                  clicks for a backfilled row. What the Warm split reads.
--
-- Old code keeps working against this shape: its INSERT omits campaign_kind and
-- takes the 'regular' default, and nullable last_click_at is never required.
-- Every ADD COLUMN here is metadata-only (nullable, or a constant default), so
-- nothing is rewritten; the lock is brief but ACCESS EXCLUSIVE, hence the
-- lock_timeout — stage_send_lifecycle is written on every send.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.lifecycle_day_rollup
  ADD COLUMN IF NOT EXISTS campaign_kind text NOT NULL DEFAULT 'regular';
--> statement-breakpoint
ALTER TABLE public.lifecycle_day_rollup
  ADD COLUMN IF NOT EXISTS purchases integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.lifecycle_day_rollup
  ADD COLUMN IF NOT EXISTS new_clickers integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.lifecycle_day_rollup
  DROP CONSTRAINT IF EXISTS lifecycle_day_rollup_campaign_kind_check;
--> statement-breakpoint
ALTER TABLE public.lifecycle_day_rollup
  ADD CONSTRAINT lifecycle_day_rollup_campaign_kind_check
  CHECK (campaign_kind IN ('regular', 'drip'));
--> statement-breakpoint
ALTER TABLE public.lifecycle_day_rollup
  DROP CONSTRAINT IF EXISTS lifecycle_day_rollup_cohort_check;
--> statement-breakpoint
ALTER TABLE public.lifecycle_day_rollup
  ADD CONSTRAINT lifecycle_day_rollup_cohort_check CHECK (
    cohort IN ('new', 'cold', 'hot', 'warm', 'warm_31_60', 'warm_61_120',
               'freeze', 'suppressed', '__unclassified__')
  );
--> statement-breakpoint
ALTER TABLE public.lifecycle_day_rollup
  DROP CONSTRAINT IF EXISTS lifecycle_day_rollup_pkey;
--> statement-breakpoint
ALTER TABLE public.lifecycle_day_rollup
  ADD CONSTRAINT lifecycle_day_rollup_pkey
  PRIMARY KEY (org_id, et_day, campaign_kind, cohort);
--> statement-breakpoint
ALTER TABLE public.stage_send_lifecycle
  ADD COLUMN IF NOT EXISTS last_click_at timestamptz;
