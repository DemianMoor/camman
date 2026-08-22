-- Migration 0148: widen segment_rules_rule_type_check for the
-- contact_attributes rule types (Drip Phase 1, item 1c; table added in 0147).
--
-- ⚠️ THIS IS THE SIXTH PLACE A RULE TYPE MUST BE REGISTERED, and the only one
-- that lives in the database. docs/07-conventions.md documented FOUR
-- (RULE_TYPES, validateValueByShape, isRuleComplete, verifyValueOwnership);
-- the SQL emitter in lib/segment-rules-eval.ts is a fifth; this CHECK is a
-- sixth, and db/schema.ts mirrors it as a seventh. Miss this one and the rule
-- validates in Zod, passes ownership, renders in the UI -- and the INSERT is
-- rejected by Postgres with a check_violation. That is the same class of
-- failure that shipped phone_type / carrier uncreatable in 0098, one layer
-- deeper.
--
-- scripts/test-segment-rule-type-registration.ts now asserts all three lists
-- (RULE_TYPES, the db/schema.ts CHECK, and this DB constraint) agree, so the
-- next rule type cannot ship half-registered.
--
-- Additive: the constraint is only ever WIDENED. Every previously-valid value
-- stays valid, so no existing row can be invalidated and there is nothing to
-- backfill or migrate.

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
      'partner_slug'
    )
  );
