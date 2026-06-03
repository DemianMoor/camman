-- Cross-instance cache for MaxMind GeoLite2 .mmdb databases.
--
-- WHY: the click-scoring lambda previously re-downloaded the .mmdb on every
-- cold start (Vercel /tmp is per-instance and ephemeral, so the existsSync
-- guard never helped across instances). At the cron cadence alone (every
-- 15 min ≈ 96 cold starts/day, ×2 editions) that blows past MaxMind's ~30
-- downloads/day GeoLite cap, after which downloads 429 and enrichment
-- silently falls back to UA-only. This table holds the blob so cold starts
-- reuse it; MaxMind is hit at most ~once/24h (gated below + an advisory
-- xact-lock so concurrent cold starts don't all fetch).
--
-- Infra cache, NOT tenant data: intentionally no org_id (the GeoLite db is
-- global). Accessed only via raw SQL in lib/links/geoip-cache.ts, so it is
-- deliberately absent from db/schema.ts (no ORM surface, no snapshot drift).
--
-- data:                the raw .mmdb bytes. NULL until a download first succeeds.
-- downloaded_at:       when `data` was last successfully refreshed. NULL = never.
--                      Freshness gate: data is considered fresh for 24h.
-- refresh_attempted_at: when a refresh was last ATTEMPTED (success or failure).
--                      Backoff gate: don't retry more than ~once/6h, so a
--                      persistent 429 day can't re-hammer the cap on every
--                      cold start.
-- etag / byte_size:    bookkeeping for diagnostics.
CREATE TABLE IF NOT EXISTS public.geoip_cache (
  edition_id            text PRIMARY KEY,
  data                  bytea,
  downloaded_at         timestamptz,
  refresh_attempted_at  timestamptz NOT NULL DEFAULT now(),
  etag                  text,
  byte_size             integer
);
