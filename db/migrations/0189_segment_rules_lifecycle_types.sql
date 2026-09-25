-- Migration 0189: the lifecycle segment rule types (spec §9), plus the two
-- contact_engagement indexes spec §4 specified and 0187 did not create.
--
-- ⚠️ THE CHECK IS THE SIXTH OF EIGHT PLACES A RULE TYPE MUST BE REGISTERED, and
-- the only one that lives in the database. Miss it and the rule validates in
-- Zod, passes ownership, renders in the editor — and the INSERT is rejected by
-- Postgres with a check_violation. That is how phone_type / carrier shipped
-- uncreatable in 0098. scripts/test-segment-rule-type-registration.ts asserts
-- RULE_TYPES, this constraint and the db/schema.ts mirror agree IN BOTH
-- DIRECTIONS, so this file and the code must land together.
--
-- Additive: the constraint is only ever WIDENED (72 rows today, all still
-- valid), so nothing can be invalidated and there is nothing to backfill.
--
-- ── THE INDEXES ────────────────────────────────────────────────────────────
-- Seven of the eight new rule types filter contact_engagement (973,731 rows /
-- 467 MB) on columns that have no index, so each is a sequential scan —
-- measured 2026-09-24: msgs_total >= 5 1,229 ms; last_sent_at < now()-30d
-- 1,418 ms; last_click_at >= now()-7d 1,022 ms. The segment preview has a hard
-- 10 s statement_timeout, so three such rules would spend 4 s of it before any
-- set arithmetic runs. (org_id, last_sent_at) and (org_id, last_click_at) are
-- exactly what spec §4 asked for; they serve the selective direction of the
-- four time rules.
--
-- NO index on msgs_total or the msgs_Nd columns: "at least N messages" is a
-- low-selectivity predicate the planner would decline to use an index for, and
-- four more indexes on a table the job rewrites every 15 minutes is real write
-- amplification for no measured gain.
--
-- ⚠️ BUILD THE INDEXES CONCURRENTLY IN PRODUCTION FIRST:
--     npx tsx scripts/apply-engagement-rule-indexes-concurrent.ts --apply
-- then run db:migrate — the IF NOT EXISTS forms below no-op and the migration
-- is still recorded in the chain. contact_engagement is written every 15
-- minutes; a plain CREATE INDEX takes ACCESS EXCLUSIVE for the whole build, and
-- CONCURRENTLY cannot run inside drizzle-kit's migration transaction. Same
-- pattern as 0101, 0109, 0143 and 0188. On a fresh/preview database the table
-- is small, so the plain form here is instant and no script run is needed.
--
-- ── ELIGIBILITY ────────────────────────────────────────────────────────────
-- None of the eight rule types filters messaging_status = 'eligible' in its own
-- subquery. gateEligible() in lib/segment-rules-eval.ts already wraps the whole
-- combined audience in an inner join on it, and that is the correctness
-- backstop for every rule that cannot gate itself. The per-rule literal that
-- phone_type / carrier / contact_added_* carry is an INDEX device (it matches
-- the eligible-PARTIAL indexes from 0096), and neither new contacts-driven case
-- has such an index to match. Owner decision, 2026-09-24.
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
      -- Contact lifecycle (spec §9)
      'messages_sent_at_least',
      'messages_sent_at_most',
      'messages_sent_in_period_at_least',
      'last_message_more_than_n_days_ago',
      'last_message_in_last_n_days',
      'last_click_more_than_n_days_ago',
      'last_click_in_last_n_days',
      'lifecycle_status'
    )
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_engagement_org_last_sent_idx
  ON public.contact_engagement (org_id, last_sent_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_engagement_org_last_click_idx
  ON public.contact_engagement (org_id, last_click_at);
