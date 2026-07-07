-- Migration 0092: add the 'in_use_in_offer' segment rule type.
--
-- New rule "In use in a specific offer": selects contacts already snapshotted
-- into a campaign_audience_pool for a campaign whose offer is the selected one
-- (campaign active/paused/completed with ≥1 live stage). Eval lives in
-- lib/segment-rules-eval.ts. Value shape is offer_id (operators is/is_not).
--
-- Widen the rule_type CHECK constraint to allow the new type. Drop + recreate
-- because Postgres has no ADD VALUE for CHECK constraints.
ALTER TABLE public.segment_rules
  DROP CONSTRAINT IF EXISTS segment_rules_rule_type_check;

ALTER TABLE public.segment_rules
  ADD CONSTRAINT segment_rules_rule_type_check CHECK (
    rule_type IN (
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
      'in_use_in_offer',
      'member_of_segment',
      'is_in_contact_group'
    )
  );
