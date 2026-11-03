SET LOCAL lock_timeout = '3s';
--> statement-breakpoint

-- Migration 0230: per-stage "Allow first name on page" flag (schema only).
--
-- ADDITIVE and INERT: defaults false, so no stage exposes a name until an
-- operator ticks the box. ADD COLUMN ... NOT NULL DEFAULT <constant> is
-- metadata-only on PG 11+ (no table rewrite). lock_timeout leads the batch for
-- the same reason as 0229: campaign_stages is read by every send and click path.
--
-- Read by the public landing-page endpoint GET /api/public/first-name
-- (lib/links/page-first-name.ts) — never by /r/ or the send pipeline.

ALTER TABLE public.campaign_stages
  ADD COLUMN IF NOT EXISTS allow_first_name_on_page boolean NOT NULL DEFAULT false;
