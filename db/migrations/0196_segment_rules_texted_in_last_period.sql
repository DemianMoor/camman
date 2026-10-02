-- 0196 — segment rule type texted_in_last_period ("Texted in the last…").
--
-- Task 3, E0 = (b) (owner, 2026-10-02): "texted within N days" read from
-- contact_engagement.last_sent_at plus a stage_sends lag tail
-- (docs/superpowers/plans/2026-10-02-task3-texted-rule-plan.md). This
-- migration only ADDS the value to the CHECK; nothing uses it until the rule
-- code ships, and no existing rule or segment changes.
--
-- The list is the LIVE production constraint (pg_get_constraintdef,
-- read 2026-10-02: 40 values, identical to 0189) plus one value. Re-compared
-- against the live constraint immediately before applying.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
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
      'carrier',
      'sent_from_provider_phone',
      'gender',
      'age_band',
      'income_band',
      'has_kids',
      'is_married',
      'contact_state',
      'contact_country',
      'interest_tag',
      'partner_slug',
      'messages_sent_at_least',
      'messages_sent_at_most',
      'messages_sent_in_period_at_least',
      'last_message_more_than_n_days_ago',
      'last_message_in_last_n_days',
      'last_click_more_than_n_days_ago',
      'last_click_in_last_n_days',
      'lifecycle_status',
      'texted_in_last_period'
    )
  );
