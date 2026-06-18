-- Migration 0075: attribute inbound TextHub STOPs to the campaign/stage(s) that
-- triggered them.
--
-- TextHub's inbox payload carries no campaign reference (only phone + body +
-- received_at), but every API send writes a stage_sends row (phone, stage_id,
-- campaign_id, sent_at). So a STOP is reverse-matched by phone + recency: the
-- poller credits every stage that sent to that number within a trailing 72h
-- window (OPT_OUT_ATTRIBUTION_WINDOW), one row per (opt_out, stage). The org-wide
-- opt_outs row is unchanged — this is additive analytics, never a suppression
-- gate. See lib/sends/poll-opt-outs.ts.
--
-- Non-destructive: one new junction table, two nullable columns on
-- texthub_inbound_events, one counter column on campaign_stages, and two
-- lookup/aggregation indexes. No backfill here — scripts/backfill-optout-
-- attributions.ts does that idempotently after this applies.

-- One credit per (opt_out, stage). stage_id / campaign_id are denormalized so the
-- attribution survives stage_send pruning (stage_send_id FK is SET NULL).
CREATE TABLE public.opt_out_attributions (
  id             serial PRIMARY KEY,
  org_id         uuid NOT NULL,
  opt_out_id     integer NOT NULL,
  stage_send_id  uuid,
  stage_id       integer NOT NULL,
  campaign_id    integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opt_out_attributions_org_id_organizations_id_fk
    FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT opt_out_attributions_opt_out_id_opt_outs_id_fk
    FOREIGN KEY (opt_out_id) REFERENCES public.opt_outs(id) ON DELETE CASCADE,
  CONSTRAINT opt_out_attributions_stage_send_id_stage_sends_id_fk
    FOREIGN KEY (stage_send_id) REFERENCES public.stage_sends(id) ON DELETE SET NULL,
  CONSTRAINT opt_out_attributions_stage_id_campaign_stages_id_fk
    FOREIGN KEY (stage_id) REFERENCES public.campaign_stages(id) ON DELETE CASCADE,
  CONSTRAINT opt_out_attributions_campaign_id_campaigns_id_fk
    FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE,
  CONSTRAINT opt_out_attributions_optout_stage_uniq
    UNIQUE (opt_out_id, stage_id)
);

CREATE INDEX opt_out_attributions_stage_id_idx ON public.opt_out_attributions (stage_id);
CREATE INDEX opt_out_attributions_campaign_id_idx ON public.opt_out_attributions (campaign_id);
CREATE INDEX opt_out_attributions_org_id_idx ON public.opt_out_attributions (org_id);

-- Per-stage live opt-out counter. Distinct from opt_out_count (CSV-imported) so
-- the two sources are never double-summed. Drives the Reports "Opt-outs" column.
ALTER TABLE public.campaign_stages
  ADD COLUMN inbound_opt_out_count integer NOT NULL DEFAULT 0;

-- Attribution debugging + window anchoring on the inbound event.
ALTER TABLE public.texthub_inbound_events
  ADD COLUMN matched_stage_send_id uuid,
  ADD COLUMN provider_received_at  timestamptz;
ALTER TABLE public.texthub_inbound_events
  ADD CONSTRAINT texthub_inbound_events_matched_stage_send_id_stage_sends_id_fk
  FOREIGN KEY (matched_stage_send_id) REFERENCES public.stage_sends(id) ON DELETE SET NULL;

-- Attribution lookup: sent rows for a number, newest-first within the window.
CREATE INDEX stage_sends_org_phone_sent_idx
  ON public.stage_sends (org_id, phone, sent_at)
  WHERE status = 'sent';
