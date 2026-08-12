-- Migration 0129: add the 'sent_from_provider_phone' segment rule type.
--
-- Selects contacts by WHICH OF OUR SENDING NUMBERS messaged them. Value is
-- {provider_id, phone_ids[]} scoped to a single provider; only stage_sends
-- rows with status='sent' count (the codebase-wide "accepted by the provider"
-- definition used by lib/reporting/rollup.ts). Eval in lib/segment-rules-eval.ts.
--
-- Distinct from the contact-side 'phone_type' / 'carrier' rules, which
-- describe the RECIPIENT's number.
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
      'sent_from_provider_phone'
    )
  );
--> statement-breakpoint

-- Supports the eval's only predicate. INCLUDE (contact_id) makes it an
-- index-only scan: the query selects nothing else.
CREATE INDEX IF NOT EXISTS stage_sends_org_provider_phone_sent_idx
  ON public.stage_sends (org_id, provider_phone_id) INCLUDE (contact_id)
  WHERE status = 'sent';
