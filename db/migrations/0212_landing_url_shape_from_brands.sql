-- 0212: landing-URL shape validation driven by brand rows, not a host list.
--
-- Replaces the CHECK link_destinations_landing_url_shape (0094→0111→0151→0170→
-- 0211), whose literal host list meant every brand added from the UI needed a
-- migration. Same shape rules, now read from brands (landing_host, landing_path):
--
--   IN SCOPE   the URL contains /<p>/ where p is 'lp' (always — the historical
--              floor) or the landing_path of any brand in the row's org that
--              has a landing_host.
--   IN-SCOPE URLs must match, for ONE of the org's (host, path) pairs:
--     ^https://<host>/<path>/[a-z0-9]+\?sub_id3=[A-Za-z0-9_]+(&[A-Za-z0-9_.~-]+=[^&[:space:]]*)*$
--   (exactly the 0170 tail: sub_id3 FIRST, slug [a-z0-9]+, extra params after).
--
-- ⚠️ A TRIGGER, NOT A CHECK. A CHECK must be immutable; one that reads brands
-- lies to Postgres (never re-evaluated, can break dump/restore). Like the old
-- NOT VALID CHECK, the trigger validates new and changed rows only — mint's
-- `ON CONFLICT DO UPDATE SET url` fires it on the update path too, so a
-- destination on a brand's OLD host is refused when re-minted after a change.
-- It raises 23514 under the old constraint name, so callers see the same error.
--
-- ⚠️ MIRRORED by validateBrandLpShape / isBrandLpUrl in lib/stage-url.ts, which
-- take the same (host, path) pairs. Change both or neither.
--
-- landing_path_collisions(): the brand-save guard. A path that is NOT yet in the
-- org's in-scope set would pull every existing URL containing /<path>/ into
-- scope; this lists the ones on a host other than the saving brand's, which
-- would then be refused at mint.
--
-- Locks (lock_timeout 5s): CREATE TRIGGER takes SHARE ROW EXCLUSIVE and DROP
-- CONSTRAINT ACCESS EXCLUSIVE on link_destinations, both momentary; a mint in
-- flight makes this fail fast instead of queueing sends behind it. The unique
-- index on brands is built on a 4-row table.
--
-- Re-runnable: CREATE OR REPLACE / DROP IF EXISTS / IF NOT EXISTS.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.landing_url_ok(p_org uuid, p_url text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH pairs AS (
    SELECT lower(b.landing_host) AS host, b.landing_path AS path
    FROM public.brands b
    WHERE b.org_id = p_org AND b.landing_host IS NOT NULL
  ), scope AS (
    SELECT 'lp'::text AS path UNION SELECT path FROM pairs
  )
  SELECT NOT EXISTS (
           SELECT 1 FROM scope WHERE strpos(p_url, '/' || scope.path || '/') > 0
         )
      OR EXISTS (
           SELECT 1 FROM pairs
           WHERE p_url ~ ('^https://' || replace(pairs.host, '.', '\.') || '/' || pairs.path
                          || '/[a-z0-9]+\?sub_id3=[A-Za-z0-9_]+(&[A-Za-z0-9_.~-]+=[^&[:space:]]*)*$')
         );
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.link_destinations_landing_url_shape_trg()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.landing_url_ok(NEW.org_id, NEW.url) THEN
    RAISE EXCEPTION 'link destination % does not match its brand landing host/path shape', NEW.url
      USING ERRCODE = '23514',
            CONSTRAINT = 'link_destinations_landing_url_shape',
            TABLE = 'link_destinations';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS link_destinations_landing_url_shape ON public.link_destinations;--> statement-breakpoint
CREATE TRIGGER link_destinations_landing_url_shape
  BEFORE INSERT OR UPDATE OF url ON public.link_destinations
  FOR EACH ROW EXECUTE FUNCTION public.link_destinations_landing_url_shape_trg();--> statement-breakpoint
ALTER TABLE public.link_destinations
  DROP CONSTRAINT IF EXISTS link_destinations_landing_url_shape;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.landing_path_collisions(
  p_org uuid, p_path text, p_host text, p_limit int DEFAULT 5
)
RETURNS TABLE (n bigint, examples text[])
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH u AS (
    SELECT url FROM public.link_destinations WHERE org_id = p_org
    UNION
    SELECT full_url FROM public.campaign_stages WHERE org_id = p_org AND full_url IS NOT NULL
  ), hit AS (
    SELECT url FROM u
    WHERE strpos(url, '/' || p_path || '/') > 0
      AND lower(coalesce(substring(url FROM '^https?://([^/?#]+)'), ''))
          IS DISTINCT FROM lower(coalesce(p_host, ''))
  )
  SELECT (SELECT count(*) FROM hit),
         coalesce((SELECT array_agg(url) FROM (SELECT url FROM hit ORDER BY url LIMIT p_limit) e), '{}');
$$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS brands_landing_pair_uniq
  ON public.brands (org_id, landing_host, landing_path)
  WHERE landing_host IS NOT NULL;
