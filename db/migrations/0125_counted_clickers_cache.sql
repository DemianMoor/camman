-- Migration 0125: counted-clicker cache for the unified EPC denominator.
--
-- One definition of "click" platform-wide. A counted clicker is a contact who,
-- within the grain being displayed, has either:
--   * at least one click with classification = 'human', or
--   * a conversion (Rule F — the numerator can never sit outside the
--     denominator; see docs/04-features/tracking-attribution.md §7a)
--
-- WHY THIS STORES THE SET AND NOT COUNTS
-- Deduplicated counts are not additive over time, exactly as they are not
-- additive across grains: one contact clicking on two days is ONE lifetime
-- clicker, not two. A per-day count cache therefore cannot produce a lifetime
-- figure by summing. Storing the deduplicated membership at the finest grain
-- (stage, contact) lets every read derive what it needs:
--   stage    -> COUNT(*)                     GROUP BY stage_id
--   campaign -> COUNT(DISTINCT contact_id)   GROUP BY campaign_id
--   creative -> COUNT(DISTINCT contact_id)   GROUP BY creative_id
--   lifetime -> no date filter
--   period   -> filter first_click_at, which is also the click-date basis the
--               period figures attribute revenue by.
--
-- WHY IT IS REBUILT WHOLESALE AND HAS NO WATERMARK
-- Load-bearing, learned the hard way. `propagate-clickers` is watermark-
-- incremental on clicks.scored_at; when the 2026-08-11 rescore backfill
-- corrected `classification` without touching `scored_at`, all 4,312 corrected
-- rows fell behind the watermark and could never be re-propagated. A watermark
-- makes a derived table silently un-repairable when its source is corrected.
-- This table is small (~72K rows) and rebuilds in seconds, so the refresh job
-- truncates and repopulates every run. Any future correction to click
-- classification self-heals on the next tick with no backfill.
CREATE TABLE IF NOT EXISTS public.counted_clickers (
  org_id       uuid    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id  integer NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  stage_id     integer NOT NULL REFERENCES public.campaign_stages(id) ON DELETE CASCADE,
  creative_id  integer,
  contact_id   uuid    NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  -- Earliest counted click for this (stage, contact). The click-date basis for
  -- period EPC. NULL only for a Rule-F rescue with no click row at all, which
  -- falls back to the conversion time.
  first_click_at timestamptz,
  -- TRUE when this row exists only because the contact converted (Rule F).
  -- Instrumented: the rescue count is a regression detector for click scoring,
  -- not merely a correction. Baseline at build time is 8.
  rescued_by_conversion boolean NOT NULL DEFAULT false,
  PRIMARY KEY (stage_id, contact_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS counted_clickers_campaign_idx
  ON public.counted_clickers (campaign_id, contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS counted_clickers_creative_idx
  ON public.counted_clickers (creative_id, contact_id)
  WHERE creative_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS counted_clickers_org_click_at_idx
  ON public.counted_clickers (org_id, first_click_at);
--> statement-breakpoint
-- Rule-F rescues are read on their own for the monitor; tiny partial index.
CREATE INDEX IF NOT EXISTS counted_clickers_rescued_idx
  ON public.counted_clickers (org_id, first_click_at)
  WHERE rescued_by_conversion;
--> statement-breakpoint
ALTER TABLE public.counted_clickers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Defense-in-depth, mirroring the other derived tables: members read their org.
DROP POLICY IF EXISTS counted_clickers_select ON public.counted_clickers;
--> statement-breakpoint
CREATE POLICY counted_clickers_select ON public.counted_clickers
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
