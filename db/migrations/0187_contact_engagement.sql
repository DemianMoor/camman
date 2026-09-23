-- Migration 0187: contact engagement — per-contact lifecycle status.
-- Spec: docs/superpowers/specs/2026-09-22-contact-lifecycle-status-design.md §4.
--
-- WHAT. Five new tables and five new columns, all additive:
--   lifecycle_settings              org singleton: the six thresholds, engine_mode
--                                   (the job's on/off switch) and
--                                   reevaluate_requested_at (used by PR 2's settings save)
--   contact_engagement              one row per contact: facts, status, freeze clock
--   contact_engagement_transitions  status history, with the thresholds in effect
--   contact_offer_campaigns         per (contact, offer, campaign) exposure — the data
--                                   ClickUp 869f53efz needs; offer_exposures keeps only
--                                   the FIRST exposure per contact x offer
--   stage_send_lifecycle            status-at-send for the cohort report; send records
--                                   are never rewritten
--   contact_groups.{freeze_after_messages, freeze_cadence_days, suppress_after_days,
--                   suppress_min_freeze_messages}  per-group overrides, NULL = inherit
--   campaigns.lifecycle_rules       false for every existing campaign; the create route
--                                   sets it once the lifecycle chips ship (PR 4)
--
-- WRITERS. Only the engagement job (lib/engagement/refresh.ts, run by
-- /api/cron/refresh-contact-engagement and scripts/engagement-backfill.ts) writes
-- contact_engagement, its transitions and contact_offer_campaigns. Nothing on
-- stage_sends, clicks or the send path changes. The job skips an org unless its
-- lifecycle_settings.engine_mode is 'write'; no row means 'off'.
--
-- NOT HERE, deliberately (each ships with the PR that uses it):
--   segment_rules.rule_type CHECK (+8 rule types) — PR 3.
--     scripts/test-segment-rule-type-registration.ts compares the CHECK with
--     RULE_TYPES in both directions, so the CHECK cannot run ahead of the code.
--   stage_sends.status CHECK (+skipped_ineligible) — PR 4. Rewriting that CHECK
--     scans the 4.3 GB send table under ACCESS EXCLUSIVE; PR 4 adds it NOT VALID
--     and VALIDATEs separately so the drain never waits.
--
-- LOCKS. The two ALTER TABLEs are catalog-only (nullable columns, a constant
-- default, and a CHECK over the ~21 contact_groups rows). They take ACCESS
-- EXCLUSIVE briefly and go first, per the strongest-lock-first rule. The new
-- foreign keys take SHARE ROW EXCLUSIVE on contacts, campaigns, offers and
-- stage_sends until commit, which pauses send-status writes for the few ms the
-- transaction lasts. lock_timeout makes a busy moment fail fast (and roll back)
-- instead of queueing behind the drain.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS lifecycle_rules boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE public.contact_groups
  ADD COLUMN IF NOT EXISTS freeze_after_messages smallint,
  ADD COLUMN IF NOT EXISTS freeze_cadence_days smallint,
  ADD COLUMN IF NOT EXISTS suppress_after_days smallint,
  ADD COLUMN IF NOT EXISTS suppress_min_freeze_messages smallint;
--> statement-breakpoint
ALTER TABLE public.contact_groups
  DROP CONSTRAINT IF EXISTS contact_groups_lifecycle_overrides_check;
--> statement-breakpoint
ALTER TABLE public.contact_groups
  ADD CONSTRAINT contact_groups_lifecycle_overrides_check CHECK (
    (freeze_after_messages IS NULL OR freeze_after_messages BETWEEN 1 AND 1000)
    AND (freeze_cadence_days IS NULL OR freeze_cadence_days BETWEEN 1 AND 365)
    AND (suppress_after_days IS NULL OR suppress_after_days BETWEEN 1 AND 730)
    AND (suppress_min_freeze_messages IS NULL OR suppress_min_freeze_messages BETWEEN 1 AND 100)
  );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.lifecycle_settings (
  org_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  hot_days smallint NOT NULL DEFAULT 30,
  warm_days smallint NOT NULL DEFAULT 120,
  freeze_after_messages smallint NOT NULL DEFAULT 10,
  freeze_cadence_days smallint NOT NULL DEFAULT 14,
  suppress_after_days smallint NOT NULL DEFAULT 60,
  suppress_min_freeze_messages smallint NOT NULL DEFAULT 2,
  -- 'off' = the job skips this org; 'write' = it maintains contact_engagement.
  -- The dry run never needs this: it rolls its own transaction back.
  engine_mode text NOT NULL DEFAULT 'off',
  reevaluate_requested_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT lifecycle_settings_ranges_check CHECK (
    hot_days BETWEEN 1 AND 365
    AND warm_days BETWEEN 2 AND 730
    AND warm_days > hot_days
    AND freeze_after_messages BETWEEN 1 AND 1000
    AND freeze_cadence_days BETWEEN 1 AND 365
    AND suppress_after_days BETWEEN 1 AND 730
    AND suppress_min_freeze_messages BETWEEN 1 AND 100
  ),
  CONSTRAINT lifecycle_settings_engine_mode_check CHECK (engine_mode IN ('off', 'write'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.contact_engagement (
  contact_id uuid PRIMARY KEY REFERENCES public.contacts(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status text NOT NULL,
  status_changed_at timestamptz NOT NULL,
  msgs_total integer NOT NULL DEFAULT 0,
  msgs_since_click integer NOT NULL DEFAULT 0,
  msgs_7d integer NOT NULL DEFAULT 0,
  msgs_14d integer NOT NULL DEFAULT 0,
  msgs_30d integer NOT NULL DEFAULT 0,
  msgs_90d integer NOT NULL DEFAULT 0,
  first_sent_at timestamptz,
  last_sent_at timestamptz,
  first_click_at timestamptz,
  last_click_at timestamptz,
  freeze_entered_at timestamptz,
  freeze_started_at timestamptz,
  freeze_msgs integer NOT NULL DEFAULT 0,
  freeze_cadence_days smallint NOT NULL,
  thresholds jsonb NOT NULL,
  -- Earliest instant at which status can change with no new send or click
  -- (hot -> warm, warm -> cold, freeze -> suppressed). NULL = never by time alone.
  time_due_at timestamptz,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_engagement_status_check
    CHECK (status IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_engagement_org_status_idx
  ON public.contact_engagement (org_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_engagement_org_time_due_idx
  ON public.contact_engagement (org_id, time_due_at) WHERE time_due_at IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.contact_engagement_transitions (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  reason text NOT NULL,
  thresholds jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_engagement_transitions_to_check
    CHECK (to_status IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed')),
  CONSTRAINT contact_engagement_transitions_from_check
    CHECK (from_status IS NULL OR from_status IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed')),
  CONSTRAINT contact_engagement_transitions_reason_check
    CHECK (reason IN ('backfill', 'first_seen', 'first_message', 'freeze_threshold',
                      'threshold_change', 'freeze_expired', 'human_click',
                      'click_aged_warm', 'click_aged_cold', 'recount'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_engagement_transitions_contact_idx
  ON public.contact_engagement_transitions (contact_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_engagement_transitions_org_idx
  ON public.contact_engagement_transitions (org_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.contact_offer_campaigns (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  offer_id integer NOT NULL REFERENCES public.offers(id) ON DELETE CASCADE,
  campaign_id integer NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  first_sent_at timestamptz NOT NULL,
  last_sent_at timestamptz NOT NULL,
  messages integer NOT NULL,
  PRIMARY KEY (contact_id, offer_id, campaign_id)
);
--> statement-breakpoint
-- The 869f53efz read: one offer's exposures per contact.
CREATE INDEX IF NOT EXISTS contact_offer_campaigns_org_offer_contact_idx
  ON public.contact_offer_campaigns (org_id, offer_id, contact_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.stage_send_lifecycle (
  stage_send_id uuid PRIMARY KEY REFERENCES public.stage_sends(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status text NOT NULL,
  reconstructed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stage_send_lifecycle_status_check
    CHECK (status IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed'))
);
--> statement-breakpoint
ALTER TABLE public.lifecycle_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.contact_engagement ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.contact_engagement_transitions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.contact_offer_campaigns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stage_send_lifecycle ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Read-only to members of the org. No INSERT/UPDATE/DELETE policy: the server's
-- own connection bypasses RLS, and it is the only writer.
DROP POLICY IF EXISTS "lifecycle_settings_select_own_org" ON public.lifecycle_settings;
--> statement-breakpoint
CREATE POLICY "lifecycle_settings_select_own_org" ON public.lifecycle_settings
  FOR SELECT USING (org_id = public.current_org_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "contact_engagement_select_own_org" ON public.contact_engagement;
--> statement-breakpoint
CREATE POLICY "contact_engagement_select_own_org" ON public.contact_engagement
  FOR SELECT USING (org_id = public.current_org_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "contact_engagement_transitions_select_own_org" ON public.contact_engagement_transitions;
--> statement-breakpoint
CREATE POLICY "contact_engagement_transitions_select_own_org" ON public.contact_engagement_transitions
  FOR SELECT USING (org_id = public.current_org_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "contact_offer_campaigns_select_own_org" ON public.contact_offer_campaigns;
--> statement-breakpoint
CREATE POLICY "contact_offer_campaigns_select_own_org" ON public.contact_offer_campaigns
  FOR SELECT USING (org_id = public.current_org_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "stage_send_lifecycle_select_own_org" ON public.stage_send_lifecycle;
--> statement-breakpoint
CREATE POLICY "stage_send_lifecycle_select_own_org" ON public.stage_send_lifecycle
  FOR SELECT USING (org_id = public.current_org_id());
