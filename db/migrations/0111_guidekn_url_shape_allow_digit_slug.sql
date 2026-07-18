-- Migration 0111: widen the guidekn destination-URL shape guard to allow
-- digit-bearing slugs (e.g. "gb1", "gb18").
--
-- Migration 0094 introduced `link_destinations_guidekn_url_shape` with a slug
-- pattern of `[a-z]+` (lowercase letters only). Real guidekn landing-page slugs
-- can contain digits — the operator hit a false-positive "tracking ID glued into
-- the path" block on the perfectly valid `.../lp/gb1?sub_id3=...`. This mirrors
-- the widened `GUIDEKN_DEST_RE` in lib/stage-url.ts: slug is now `[a-z0-9]+`.
--
-- The concatenation defect this guard protects against is unaffected: a glued
-- tracking id always carries UNDERSCORES in the path (e.g. .../lp/gb18_80_...),
-- which `[a-z0-9]+` still cannot match before the required `?sub_id3=`.
--
-- Re-added NOT VALID, exactly as 0094: enforce the shape on every future
-- INSERT/UPDATE without rescanning legacy rows (dest 2152 / stage 516 remains a
-- deliberately-abandoned exception — see scripts/backfill-guidekn-destinations.ts).
ALTER TABLE public.link_destinations
  DROP CONSTRAINT IF EXISTS link_destinations_guidekn_url_shape;

ALTER TABLE public.link_destinations
  ADD CONSTRAINT link_destinations_guidekn_url_shape
  CHECK (
    url NOT LIKE '%guidekn.com/lp/%'
    OR url ~ '^https://www\.guidekn\.com/lp/[a-z0-9]+\?sub_id3=[A-Za-z0-9_]+$'
  ) NOT VALID;
