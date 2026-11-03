SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- Migration 0229: per-stage "Add ZIP / State to URL" flags (schema only).
--
-- ADDITIVE and INERT: both default false, so every existing stage behaves
-- exactly as today. ADD COLUMN ... NOT NULL DEFAULT <constant> is metadata-only
-- on PG 11+ (no table rewrite). lock_timeout leads the batch because
-- campaign_stages is read by every send and click path — fail fast rather than
-- queue behind (and block) them.
--
-- The params are appended at REDIRECT time (lib/links/resolve-click.ts), so no
-- shape regex, link_destinations trigger or CHECK changes here.

ALTER TABLE public.campaign_stages
  ADD COLUMN IF NOT EXISTS url_add_zip boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS url_add_state boolean NOT NULL DEFAULT false;
