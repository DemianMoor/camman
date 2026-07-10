-- Migration 0094: enforce the canonical guidekn destination-URL shape.
--
-- A string-concatenation bug historically wrote malformed guidekn destinations
-- into link_destinations (the tracking id glued into the path, an empty sub_id3,
-- an unsubstituted `subid3=sub_id3` placeholder). Each ships a 404 to the
-- recipient and silently kills attribution. This CHECK is the last line of
-- defence — no code path can write a malformed guidekn URL again.
--
-- The `NOT LIKE '%guidekn.com/lp/%'` guard means NON-guidekn destinations
-- (network URLs, other domains) are unaffected — they're out of scope of the
-- guidekn contract. Mirrors lib/stage-url.ts `validateDestination`.
--
-- Added NOT VALID: it enforces the shape on every future INSERT/UPDATE
-- immediately, but does NOT scan existing rows. That lets it apply cleanly even
-- while a small number of legacy malformed rows are still being triaged by hand
-- (see scripts/backfill-guidekn-destinations.ts). Once all legacy rows are
-- canonical, run `ALTER TABLE public.link_destinations VALIDATE CONSTRAINT
-- link_destinations_guidekn_url_shape;` (a follow-up migration) to mark the
-- existing rows verified. Fresh environments have no rows, so NOT VALID is
-- fully sufficient there.
ALTER TABLE public.link_destinations
  ADD CONSTRAINT link_destinations_guidekn_url_shape
  CHECK (
    url NOT LIKE '%guidekn.com/lp/%'
    OR url ~ '^https://www\.guidekn\.com/lp/[a-z]+\?sub_id3=[A-Za-z0-9_]+$'
  ) NOT VALID;
