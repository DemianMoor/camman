SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- Migration 0228: partner passthrough fields + sales postbacks (schema only).
--
-- ADDITIVE and INERT: every new key column defaults to "off"/empty, so no
-- existing partner behaves differently until an owner configures it.
-- lock_timeout leads the batch because lead_inbox is written by live intake —
-- fail fast rather than queue behind (and block) the intake path.
--
-- partner_postbacks.conversion_event_id is ON DELETE RESTRICT on purpose:
-- deleting a ledger row with a postback behind it must fail loudly. It is NULL
-- only for test postbacks (is_test).

ALTER TABLE public.partner_keys
  ADD COLUMN passthrough_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN postback_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN postback_url_template text,
  ADD COLUMN postback_include_payout boolean NOT NULL DEFAULT false,
  ADD COLUMN postback_first_purchase_only boolean NOT NULL DEFAULT false,
  ADD COLUMN postback_event_keys text[] NOT NULL DEFAULT '{purchase}',
  ADD COLUMN postback_active_since timestamptz;
--> statement-breakpoint

ALTER TABLE public.partner_keys
  ADD CONSTRAINT partner_keys_passthrough_fields_check
    CHECK (jsonb_typeof(passthrough_fields) = 'array' AND jsonb_array_length(passthrough_fields) <= 10),
  ADD CONSTRAINT partner_keys_postback_event_keys_check
    CHECK (postback_event_keys <@ ARRAY['purchase']::text[] AND cardinality(postback_event_keys) >= 1),
  ADD CONSTRAINT partner_keys_postback_enabled_needs_template_check
    CHECK ((NOT postback_enabled OR postback_url_template IS NOT NULL)
           AND (postback_url_template IS NULL OR char_length(postback_url_template) <= 2048));
--> statement-breakpoint

ALTER TABLE public.lead_inbox ADD COLUMN partner_data jsonb;
--> statement-breakpoint

ALTER TABLE public.lead_events ADD COLUMN partner_data jsonb;
--> statement-breakpoint

CREATE TABLE public.partner_postbacks (
  id                  bigserial PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  partner_key_id      integer NOT NULL REFERENCES public.partner_keys(id) ON DELETE RESTRICT,
  conversion_event_id bigint REFERENCES public.conversion_events(id) ON DELETE RESTRICT,
  drip_journey_id     uuid REFERENCES public.drip_journeys(id) ON DELETE SET NULL,
  lead_event_id       uuid REFERENCES public.lead_events(id) ON DELETE SET NULL,
  is_test             boolean NOT NULL DEFAULT false,
  payload             jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  attempts            integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  last_attempt_at     timestamptz,
  delivered_at        timestamptz,
  last_response_code  integer,
  last_error          text,
  last_url_masked     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_postbacks_status_check
    CHECK (status IN ('pending', 'delivered', 'failed', 'cancelled'))
);
--> statement-breakpoint

-- One real postback per (key, conversion); test rows (NULL conversion) coexist.
CREATE UNIQUE INDEX partner_postbacks_key_conversion_uniq
  ON public.partner_postbacks (partner_key_id, conversion_event_id)
  WHERE NOT is_test;
--> statement-breakpoint

CREATE INDEX partner_postbacks_due_idx
  ON public.partner_postbacks (next_attempt_at)
  WHERE status = 'pending';
--> statement-breakpoint

CREATE INDEX partner_postbacks_key_created_idx
  ON public.partner_postbacks (partner_key_id, created_at DESC);
--> statement-breakpoint

CREATE INDEX partner_postbacks_journey_idx
  ON public.partner_postbacks (drip_journey_id)
  WHERE NOT is_test;
--> statement-breakpoint

ALTER TABLE public.partner_postbacks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "partner_postbacks_select_own_org"
  ON public.partner_postbacks FOR SELECT
  USING (org_id = public.current_org_id());
