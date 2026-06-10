-- New segment rule type: in_use_in_campaign_last_period.
--
-- Matches contacts already snapshotted into a campaign that ran (status
-- active/paused/completed) within a fixed lookback window AND still has at
-- least one live stage (draft/pending/sent/success). Campaigns whose stages
-- are all cancelled/failed release their contacts. The lookback window codes
-- (1d/3d/1w/2w/1m/3m/6m/1y) live in the rule's `value`; the code → interval
-- mapping is server-side (lib/segment-rules-eval.ts).
--
-- Additive: this only widens the rule_type CHECK constraint, so existing
-- rows are unaffected. The full IN-list is restated (Postgres has no
-- "add value to CHECK" primitive) and includes is_in_contact_group, which
-- was added in 0031 but never made it back into the generated snapshots.

ALTER TABLE public.segment_rules DROP CONSTRAINT segment_rules_rule_type_check;
--> statement-breakpoint
ALTER TABLE public.segment_rules ADD CONSTRAINT segment_rules_rule_type_check CHECK (rule_type IN (
  'is_clicker_any_brand',
  'is_clicker_for_brand',
  'is_clicker_for_offer',
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
