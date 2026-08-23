-- Migration 0160: drip_campaign_configs — the drip-only campaign settings
-- (Drip Phase 4).
--
-- 1:1 with a drip campaign, PK = campaign_id. Same structural choice as
-- contact_attributes in Phase 1 item 1c: the 1:1 is enforced by the primary key,
-- so a second config row for one campaign is impossible by construction.
--
-- ⚠️ start_at / end_at are NEW timestamptz columns; campaigns.start_date and
-- campaigns.end_date are UNTOUCHED. Those are `date`, cannot express a hard
-- boundary (there is no "start at 09:00" in a DATE), and 287 of 295 existing
-- campaigns already set them as advisory metadata — repurposing them would
-- silently change the meaning of 287 live rows.
--
-- ⚠️ THREE CAPS, THREE DIFFERENT WINDOWS, DELIBERATELY NAMED APART:
--
--   campaign_cap                — LIFETIME journeys. Enforced at ROUTING, and
--                                 stays there: a journey IS the commitment.
--   daily_cap                   — SENDS per ET day. Stored and displayed now but
--                                 INERT in Phase 4; Phase 5 enforces it at send
--                                 time, where it belongs.
--   routing_daily_admission_cap — journeys admitted per ET day. The distinctly
--                                 named throttle. NULL = unlimited.
--
-- The reason they cannot be one number: a journey routed at 23:50 ET sends the
-- NEXT day, so today's journeys are not today's sends. Enforcing a send cap
-- against journeys now and against sends in Phase 5 would give two caps fighting
-- over one field, and an operator could not tell "not routed, admission full"
-- from "not sent, send cap full". Every surface that shows these must keep the
-- names distinct.
--
-- ⚠️ Demographic filters live in ONE jsonb, not seven columns. The rule is
-- uniform (skip-if-missing) and the set is explicitly extensible per the spec;
-- seven nullable columns would need a migration per new filter. Validated in Zod
-- against the contact_attributes field list, the same discipline segment rule
-- values use. The CARRIER filter is NOT duplicated here — drip reuses
-- campaigns.audience_filters.carrier_filter, which 185 of 295 campaigns already
-- populate.
--
-- ADDITIVE. New table only.

CREATE TABLE public.drip_campaign_configs (
  campaign_id     integer PRIMARY KEY REFERENCES public.campaigns(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- The required routing dimension.
  interest_tag    text NOT NULL,
  -- Optional narrowing to one partner.
  partner_key_id  integer REFERENCES public.partner_keys(id) ON DELETE SET NULL,

  -- Hard window: a lead is eligible when received_at ∈ [start_at, end_at).
  start_at        timestamptz,
  end_at          timestamptz,

  daily_cap                   integer,
  campaign_cap                integer,
  routing_daily_admission_cap integer,

  -- Lower wins. Ties broken by the most recently created campaign.
  priority        integer NOT NULL DEFAULT 100,

  -- gender / age_band / state / country / income_band / kids / married.
  filters         jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT drip_campaign_configs_window_check
    CHECK (end_at IS NULL OR start_at IS NULL OR end_at > start_at),
  CONSTRAINT drip_campaign_configs_daily_cap_check
    CHECK (daily_cap IS NULL OR daily_cap > 0),
  CONSTRAINT drip_campaign_configs_campaign_cap_check
    CHECK (campaign_cap IS NULL OR campaign_cap > 0),
  CONSTRAINT drip_campaign_configs_admission_cap_check
    CHECK (routing_daily_admission_cap IS NULL OR routing_daily_admission_cap > 0),
  CONSTRAINT drip_campaign_configs_interest_tag_check
    CHECK (length(btrim(interest_tag)) > 0)
);
--> statement-breakpoint

-- The routing worker's candidate scan: drip campaigns matching a lead's tag.
CREATE INDEX drip_campaign_configs_org_tag_idx
  ON public.drip_campaign_configs (org_id, interest_tag);
--> statement-breakpoint

-- Winner selection: priority ASC, then newest campaign.
CREATE INDEX drip_campaign_configs_org_priority_idx
  ON public.drip_campaign_configs (org_id, priority, campaign_id DESC);
--> statement-breakpoint

ALTER TABLE public.drip_campaign_configs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "drip_campaign_configs_select_own_org"
  ON public.drip_campaign_configs FOR SELECT
  USING (org_id = public.current_org_id());
