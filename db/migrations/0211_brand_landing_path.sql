-- 0211: per-brand landing path. Additive.
--
--   brands.landing_path — the bare path segment a kind='slug' landing page is
--   served under: https://<landing_host>/<landing_path>/<slug>. Default 'lp',
--   so every existing brand keeps minting byte-identical /lp/ URLs. Stored with
--   no slashes; lowercase letters, digits and inner dashes only.
--
--   CascadeBlog (brand code 'cas') serves its landing pages at
--   https://blogcascade.com/bcf/<slug> (www 308s to the apex), so it gets
--   landing_host 'blogcascade.com' + landing_path 'bcf'. Matched on code AND
--   website, and only while landing_host is still NULL, so this is a no-op
--   anywhere that brand does not exist or was already set by hand.
--
--   link_destinations_landing_url_shape gains a blogcascade.com/bcf/ branch with
--   the exact 0170 shape (sub_id3 FIRST, slug [a-z0-9]+, extra params after).
--   The /lp/ branch is unchanged. Before this, a /bcf/ URL was exempt from the
--   CHECK entirely. Stays NOT VALID like 0170; existing rows are not rescanned
--   (prod 2026-10-14: 1 /bcf/ row, and it matches the new shape).
--
--   ⚠️ The host list here is mirrored by BRAND_LP_SHAPE_RE in lib/stage-url.ts.
--   Change both or neither.
--
-- Re-runnable: IF NOT EXISTS / DROP IF EXISTS / guarded UPDATE.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS landing_path text NOT NULL DEFAULT 'lp';--> statement-breakpoint
ALTER TABLE public.brands
  DROP CONSTRAINT IF EXISTS brands_landing_path_shape_check;--> statement-breakpoint
ALTER TABLE public.brands
  ADD CONSTRAINT brands_landing_path_shape_check CHECK (
    landing_path ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  );--> statement-breakpoint
COMMENT ON COLUMN public.brands.landing_path IS
  'Bare path segment (no slashes) for kind=slug landing pages: https://<landing_host>/<landing_path>/<slug> (0211). Default lp.';--> statement-breakpoint
UPDATE public.brands
  SET landing_host = 'blogcascade.com', landing_path = 'bcf'
  WHERE brand_id = 'cas'
    AND website ILIKE '%blogcascade.com%'
    AND landing_host IS NULL;--> statement-breakpoint
ALTER TABLE public.link_destinations
  DROP CONSTRAINT IF EXISTS link_destinations_landing_url_shape;--> statement-breakpoint
ALTER TABLE public.link_destinations
  ADD CONSTRAINT link_destinations_landing_url_shape CHECK (
    (url NOT LIKE '%/lp/%' AND url NOT LIKE '%blogcascade.com/bcf/%')
    OR url ~ '^https://(www\.guidekn\.com|www\.lumzen\.co|www\.fitsyou\.net)/lp/[a-z0-9]+\?sub_id3=[A-Za-z0-9_]+(&[A-Za-z0-9_.~-]+=[^&[:space:]]*)*$'
    OR url ~ '^https://blogcascade\.com/bcf/[a-z0-9]+\?sub_id3=[A-Za-z0-9_]+(&[A-Za-z0-9_.~-]+=[^&[:space:]]*)*$'
  ) NOT VALID;
