-- Migration 0069: add the three made_purchase_* segment rule types
-- (engagement Level 3 — "made a purchase").
--
-- These rules match contacts who have at least one stage_sends row with
-- sale_status='sale' (NOT 'lead' or 'rejected'). Scoping mirrors the clicker
-- rules: any / specific brand / specific offer (brand & offer live on the
-- parent campaign, joined at eval time — see lib/segment-rules-eval.ts).
--
-- This widens the existing CHECK by three allowed values. The recreated
-- constraint also restores 'is_in_contact_group', which a prior hand-authored
-- migration added to the live DB but which had drifted out of the Drizzle
-- schema's check() definition — so the constraint text here is the full,
-- accurate allow-list.
--
-- Non-destructive: no data migrated, no rows rewritten. Reversible by dropping
-- the three new values from the CHECK.

ALTER TABLE segment_rules DROP CONSTRAINT segment_rules_rule_type_check;
ALTER TABLE segment_rules ADD CONSTRAINT segment_rules_rule_type_check
  CHECK (rule_type IN (
    'is_clicker_any_brand',
    'is_clicker_for_brand',
    'is_clicker_for_offer',
    'made_purchase',
    'made_purchase_for_brand',
    'made_purchase_for_offer',
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
