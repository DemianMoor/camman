-- Migration 0098: add the 'phone_type' and 'carrier' segment rule types.
--
-- phone_type: contacts whose line_type is in a chosen set {mobile, voip,
--   toll_free, unknown}. 'landline' is intentionally NOT offered — landlines are
--   messaging_status='not_applicable' and absent from segment evaluation entirely.
-- carrier: contacts whose carrier_norm is in a chosen set {AT&T, T-Mobile,
--   Verizon, Other Mobile, VoIP, Unknown}; 'Unknown' matches ('Unknown','Unmapped').
--
-- Both evaluate against the denormalized, eligible-partial-indexed contact columns.
-- Value shape is a string set; operators map through the existing set-arithmetic
-- (is -> membership, is_not -> EXCEPT). Eval in lib/segment-rules-eval.ts.
--
-- Widen the rule_type CHECK (drop + recreate — Postgres has no ADD VALUE for CHECK).
ALTER TABLE public.segment_rules
  DROP CONSTRAINT IF EXISTS segment_rules_rule_type_check;
--> statement-breakpoint

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
      'is_in_contact_group',
      'phone_type',
      'carrier'
    )
  );
