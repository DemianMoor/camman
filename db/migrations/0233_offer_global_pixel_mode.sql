-- 0233: per-offer handling of an advertiser's GLOBAL pixel.
--
-- Owner ruling 2026-11-05. Some advertisers (Affiliati) cannot switch their
-- global pixel off per offer. It always posts status=sale and never carries a
-- `from=` marker, while CamMan's offer-specific postback URLs always end in
-- `from=<network code>` (lib/conversions/postback-urls.ts). On the debt offers
-- the global pixel fires on a form submit, so its "sale" is really a lead.
--
-- offers.global_pixel_mode says what an UNMARKED conversion on this offer
-- counts as (read from the offer the conversion is STORED under):
--   default  — the network rules, exactly as before (every existing offer)
--   lead     — event type forced to the org's `lead` type
--   purchase — event type forced to the org's `purchase` type
--   ignore   — the conversion is not written at all
-- A conversion WITH the marker always follows the network rules, and a reversal
-- (a status-only rule, e.g. `rejected`) is never overridden. Logic:
-- lib/conversions/build-rows.ts applyGlobalPixelMode.
--
-- Additive and inert: the default reproduces today's behaviour byte-for-byte.

SET LOCAL lock_timeout = '5s';

ALTER TABLE offers
  ADD COLUMN global_pixel_mode text NOT NULL DEFAULT 'default';

ALTER TABLE offers
  ADD CONSTRAINT offers_global_pixel_mode_check
  CHECK (global_pixel_mode IN ('default', 'lead', 'purchase', 'ignore'));
