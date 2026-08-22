-- Migration 0151: widen the minted-destination shape CHECK to any brand's
-- landing host (Drip Phase 1, item 1b). Separate from 0150 by ruling.
--
-- BEFORE (0094, tightened by 0111):
--   CHECK (url NOT LIKE '%guidekn.com/lp/%'
--          OR url ~ '^https://www\.guidekn\.com/lp/[a-z0-9]+\?sub_id3=[A-Za-z0-9_]+$')
--   NOT VALID
--
-- Three properties are PRESERVED deliberately:
--
--   1. THE CONDITIONAL SHAPE. A URL that is not an /lp/ URL is exempt entirely.
--      17 of the 1,072 current destinations are non-/lp/ paths (/mind, /body)
--      and pass today by exemption; they must keep passing.
--   2. THE SINGLE-PARAM RULE. Exactly one query param, sub_id3. Ruled: on /lp/
--      destinations UTM tags are never appended -- tracking is already carried
--      by sub_id3, and the one tag that would be appended emits the literal
--      `subid3=sub_id3`, which is the "unsubstituted placeholder" defect this
--      very constraint names.
--   3. NOT VALID. Existing rows are grandfathered; only future inserts are
--      checked.
--
-- MEASURED IMPACT (production, 2026-08-22): of 1,055 /lp/ destinations exactly
-- ONE would fail --
--   https://www.guidekn.com/lp/knd?sub_id3=8_62_061226_3_s6_c124&subid3=sub_id3
-- the known historic placeholder row from stage 516's lineage, deliberately
-- abandoned when 0094 shipped. NOT VALID leaves it in place.
--
-- ⚠️ This is a TIGHTENING as well as a widening. Today a lumzen.co//lp/ or
-- fitsyou.net//lp/ destination is exempt (it is not guidekn) and afterwards must
-- match the canonical shape. Of the 7 LumZen + 3 FitsYou destinations, 9 of 10
-- already conform; the tenth is the same placeholder row.
--
-- ⚠️ THE HOST LIST IS HARDCODED, exactly as it was before. A CHECK constraint
-- cannot subquery `brands`, so ADDING A FOURTH BRAND REQUIRES A MIGRATION to
-- widen this list. That cost is accepted deliberately (defense in depth is the
-- whole reason 0094 exists); scripts/test-landing-host-check-sync.ts asserts
-- this list still matches brands.landing_host so the two cannot drift silently.

ALTER TABLE public.link_destinations
  DROP CONSTRAINT IF EXISTS link_destinations_guidekn_url_shape;
--> statement-breakpoint

ALTER TABLE public.link_destinations
  ADD CONSTRAINT link_destinations_landing_url_shape CHECK (
    url NOT LIKE '%/lp/%'
    OR url ~ '^https://(www\.guidekn\.com|www\.lumzen\.co|www\.fitsyou\.net)/lp/[a-z0-9]+\?sub_id3=[A-Za-z0-9_]+$'
  ) NOT VALID;
