-- Phase 3: bot/prefetch scoring enrichment on click rows.
--
-- The Phase-2 clicks table only carried a first-pass `classification`
-- (human/bot/prefetch/unknown from UA + headers). This adds the enrichment
-- and scoring columns the scoring job populates:
--   * asn / asn_org / country — from a MaxMind GeoLite2-ASN lookup of the IP
--   * is_datacenter           — derived from a maintained hosting-ASN list
--                               (GeoLite2 has no hosting flag); NULL = not yet
--                               determined
--   * seconds_since_send      — DEFERRED: no send pipeline records a per-message
--                               send time yet. Stays NULL until minting runs at
--                               send time, then ≈ clicked_at - links.created_at.
--   * bot_score (0-100)       — computed score; default 0
--   * bot_reasons (jsonb)     — array of which signals fired, recorded on EVERY
--                               scored row (incl. human) so near-misses are
--                               visible when thresholds are retuned
--   * scored_at               — when the row was last scored; NULL = NOT YET
--                               SCORED. This is the authoritative scored-state
--                               marker (NOT `classification`). `classification`
--                               stays the Phase-2 inline first-pass verdict on
--                               insert and is OVERWRITTEN with the refined
--                               verdict (human/suspect/prefetch/bot) by the job.
--
-- classify-don't-delete: raw rows are never deleted; scoring only annotates.
-- Scoring is run by a cron-triggered job (/api/clicks/score-pending) over
-- pending rows (scored_at IS NULL), and re-runnably over all rows in re-score
-- mode. The 'unknown' classification value means "inline couldn't tell from the
-- UA" (e.g. no UA) — it does NOT mean "unscored"; scored_at does.

ALTER TABLE public.clicks
  ADD COLUMN asn                integer,
  ADD COLUMN asn_org            text,
  ADD COLUMN country            text,
  ADD COLUMN is_datacenter      boolean,
  ADD COLUMN seconds_since_send integer,
  ADD COLUMN bot_score          integer NOT NULL DEFAULT 0,
  ADD COLUMN bot_reasons        jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN scored_at          timestamptz;
--> statement-breakpoint

-- Extend the classification check to add 'suspect' (the mid-tier verdict).
-- 'unknown' is retained and means "not yet scored".
ALTER TABLE public.clicks
  DROP CONSTRAINT clicks_classification_check;
--> statement-breakpoint

ALTER TABLE public.clicks
  ADD CONSTRAINT clicks_classification_check
  CHECK (classification IN ('human', 'suspect', 'prefetch', 'bot', 'unknown'));
--> statement-breakpoint

-- Lets the scoring job find pending rows (scored_at IS NULL) cheaply without
-- scanning the whole (high-volume) table.
CREATE INDEX clicks_pending_idx ON public.clicks (id) WHERE scored_at IS NULL;
