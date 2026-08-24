-- Migration 0165: drip_campaign_numbers — per-campaign number selection with a
-- per-number daily limit (Drip Phase 5).
--
-- A drip campaign sends from a chosen SET of the brand's numbers, rotating to
-- the next one with headroom. This is not the same thing as a regular stage's
-- single `provider_phone_id`: a drip campaign runs continuously all day and one
-- number cannot carry it.
--
-- ⚠️ THE BRAND CONSTRAINT IS NOT DUPLICATED HERE. Which numbers may be selected
-- is already decided by the Phase 1 brand -> number rule (a stage may only use a
-- number registered to its campaign's brand). The picker and the server-side
-- check both go through that one guard, so this table stores the CHOICE, not a
-- second copy of the rule. Two copies of an authorization rule is how the two
-- in-use definitions drifted apart in Phase 4.
--
-- ⚠️ NO OVERFLOW ONTO AN UNLISTED NUMBER, EVER. When every listed number has
-- hit its daily limit, the journeys WAIT for the next ET day and a
-- state-transition alert fires. Silently borrowing a number the operator did
-- not choose would put an unknown number's carrier reputation at risk and break
-- the brand rule at the same time.
--
-- ADDITIVE. New table only.

CREATE TABLE public.drip_campaign_numbers (
  campaign_id       integer NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  provider_phone_id integer NOT NULL REFERENCES public.provider_phones(id) ON DELETE RESTRICT,
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Sends per ET day from THIS number for THIS campaign. NULL = no per-number
  -- limit from drip's side (the provider's own pacing still applies).
  daily_limit       integer,

  -- Rotation order when several numbers have headroom. Lower first.
  position          integer NOT NULL DEFAULT 0,

  created_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (campaign_id, provider_phone_id),

  CONSTRAINT drip_campaign_numbers_daily_limit_check
    CHECK (daily_limit IS NULL OR daily_limit > 0)
);
--> statement-breakpoint

-- ON DELETE RESTRICT on the phone: removing a number that a live drip campaign
-- is sending from should fail loudly, not silently strand the campaign with
-- nowhere to send. Archive the number instead.

-- The rotation scan: this campaign's numbers in order.
CREATE INDEX drip_campaign_numbers_campaign_position_idx
  ON public.drip_campaign_numbers (campaign_id, position, provider_phone_id);
--> statement-breakpoint

CREATE INDEX drip_campaign_numbers_org_idx
  ON public.drip_campaign_numbers (org_id);
--> statement-breakpoint

ALTER TABLE public.drip_campaign_numbers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "drip_campaign_numbers_select_own_org"
  ON public.drip_campaign_numbers FOR SELECT
  USING (org_id = public.current_org_id());
