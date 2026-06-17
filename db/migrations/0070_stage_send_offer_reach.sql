-- Migration 0070: per-recipient offer-page reach (engagement Level 2) +
-- the reached_offer_* segment rule types.
--
-- Mirrors the Level-3 sale work (0067 columns + 0069 rule types), combined here
-- into one migration. An OFFER-campaign click in Keitaro (campaign name !=
-- gk-lp-visits) that carries sub_id_1 = stage_sends.id means that recipient
-- reached the offer page. The offer-reach poll (lib/keitaro/poll-offer-reaches.ts)
-- reads clicks/log, drops landing (gk-lp-visits) clicks, and stamps these columns.
--
-- Reach is MONOTONIC: offer_reached_at is the earliest such click and is never
-- changed once set; offer_reach_event_id is the Keitaro click event_id, the dedup
-- key across overlapping rolling poll windows.
--
-- Tracked sends only: manual-mode rows mint no link and reach no redirect, so
-- they never carry a sub_id1 and these columns stay NULL for them (expected).
--
-- Non-destructive: two nullable columns + one partial index, plus a CHECK
-- restatement that widens the allowed rule-type list. No backfill, no rewrite.

ALTER TABLE stage_sends
  ADD COLUMN offer_reached_at     TIMESTAMPTZ,
  ADD COLUMN offer_reach_event_id TEXT;

-- "Show me who reached the offer" reads only ever want the stamped rows.
CREATE INDEX stage_sends_offer_reached_at_idx
  ON stage_sends (offer_reached_at)
  WHERE offer_reached_at IS NOT NULL;

-- Widen the rule-type allow-list with the three Level-2 types. Postgres can't
-- append to a CHECK, so restate the full IN-list (matches db/schema.ts).
ALTER TABLE segment_rules DROP CONSTRAINT segment_rules_rule_type_check;
ALTER TABLE segment_rules ADD CONSTRAINT segment_rules_rule_type_check
  CHECK (rule_type IN (
    'is_clicker_any_brand',
    'is_clicker_for_brand',
    'is_clicker_for_offer',
    'made_purchase',
    'made_purchase_for_brand',
    'made_purchase_for_offer',
    'reached_offer',
    'reached_offer_for_brand',
    'reached_offer_for_offer',
    'is_optin_any_brand',
    'is_optin_for_brand',
    'is_optout_for_brand',
    'contact_added_in_last_n_days',
    'contact_added_more_than_n_days_ago',
    'joined_segment_in_last_n_days',
    'joined_segment_more_than_n_days_ago',
    'in_use_in_campaign_last_period',
    'member_of_segment',
    'is_in_contact_group'
  ));
