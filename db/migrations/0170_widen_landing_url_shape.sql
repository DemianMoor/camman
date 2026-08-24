-- Migration 0170: allow extra query params after sub_id3 on a brand /lp/ URL.
--
-- ⚠️ THIS RELAXES AN ATTRIBUTION GUARD, DELIBERATELY AND NARROWLY.
-- The 0094 constraint (widened for digit-bearing slugs in 0111) was anchored so
-- that a /lp/ destination could carry EXACTLY ONE parameter. That made an
-- operator-added UTM parameter impossible: the stage saved happily and every
-- lead was then skipped at mint with invalid_destination, hours later.
--
-- ⚠️ WHAT IS DELIBERATELY *NOT* RELAXED. The leading parameter must still be
-- literally `sub_id3=` followed by [A-Za-z0-9_]+, and the slug must still be
-- [a-z0-9]+. That keeps every defect 0094 exists for:
--
--   A  tracking id concatenated into the path (…/lp/knd8_62_…)
--        -- the slug class has no underscore
--   B  an empty sub_id3 (…?sub_id3= or …?sub_id3=&utm=x)
--        -- the value class requires at least one character
--   C  the unsubstituted placeholder `subid3=sub_id3`
--        -- the key must be sub_id3 exactly, not subid3
--   D  no sub_id3 at all
--        -- it is mandatory and FIRST
--   E  percent-encoded artifacts such as the `_s%3F_c%3F` preview bug
--        -- '%' is not in [A-Za-z0-9_]
--
-- and it additionally requires sub_id3 to come FIRST, so the tracking parameter
-- can be found by position rather than by parsing.
--
-- Verified on preview against 13 cases before writing: 4 accept (canonical plus
-- three widened shapes), 9 reject (all of A-E, sub_id3 not first, unknown host,
-- whitespace in a value).
--
-- ⚠️ STAYS `NOT VALID`, exactly as before. One legacy row (stage_id=516) was
-- deliberately left un-repaired when 0094 landed; VALIDATE is still not this
-- migration's business. New and updated rows are enforced.

ALTER TABLE public.link_destinations
  DROP CONSTRAINT IF EXISTS link_destinations_landing_url_shape;
--> statement-breakpoint

ALTER TABLE public.link_destinations
  ADD CONSTRAINT link_destinations_landing_url_shape CHECK (
    url NOT LIKE '%/lp/%'
    OR url ~ '^https://(www\.guidekn\.com|www\.lumzen\.co|www\.fitsyou\.net)/lp/[a-z0-9]+\?sub_id3=[A-Za-z0-9_]+(&[A-Za-z0-9_.~-]+=[^&[:space:]]*)*$'
  ) NOT VALID;
