SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- Migration 0234: per-event partner postbacks (purchase / opt_out / invalid).
--
-- ADDITIVE and INERT: every existing row and key keeps behaving as before
-- (event defaults to 'purchase', event keys stay {purchase}). lock_timeout
-- leads the batch because partner_keys is read by live intake.
--
-- partner_postbacks.lead_inbox_id has NO foreign key on purpose: the inbox row
-- is deleted in the same transaction that writes the 'invalid' postback.

ALTER TABLE public.partner_postbacks
  ADD COLUMN event text NOT NULL DEFAULT 'purchase',
  ADD COLUMN lead_inbox_id uuid;
--> statement-breakpoint

ALTER TABLE public.partner_postbacks
  ADD CONSTRAINT partner_postbacks_event_check
    CHECK (event IN ('purchase', 'opt_out', 'invalid'));
--> statement-breakpoint

-- One real opt_out postback per (key, journey); one invalid per (key, inbox row).
-- Test rows are exempt. The per-conversion index stays (NULL conversions never collide).
CREATE UNIQUE INDEX partner_postbacks_key_journey_optout_uniq
  ON public.partner_postbacks (partner_key_id, drip_journey_id)
  WHERE NOT is_test AND event = 'opt_out';
--> statement-breakpoint

CREATE UNIQUE INDEX partner_postbacks_key_inbox_invalid_uniq
  ON public.partner_postbacks (partner_key_id, lead_inbox_id)
  WHERE NOT is_test AND event = 'invalid';
--> statement-breakpoint

ALTER TABLE public.partner_keys
  ADD COLUMN postback_status_words jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN postback_event_since jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

ALTER TABLE public.partner_keys
  DROP CONSTRAINT partner_keys_postback_event_keys_check,
  ADD CONSTRAINT partner_keys_postback_event_keys_check
    CHECK (postback_event_keys <@ ARRAY['purchase','opt_out','invalid']::text[] AND cardinality(postback_event_keys) >= 1);
--> statement-breakpoint

-- Purchase has been live since postback_active_since; carry that into the per-event map.
UPDATE public.partner_keys
  SET postback_event_since = jsonb_build_object('purchase', to_jsonb(postback_active_since))
  WHERE postback_active_since IS NOT NULL;
