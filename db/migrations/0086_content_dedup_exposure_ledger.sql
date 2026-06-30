-- Migration 0086: content deduplication & offer exposure ledgers.
--
-- Three tables, three jobs (kept separate — see docs/04-features/content-dedup.md):
--   1. creative_exposures  — the hard-rule ledger. UNIQUE (org_id, contact_id,
--      creative_id) guarantees the same creative is recorded against a contact
--      exactly once; campaign_id holds the FIRST campaign that sent it (needed
--      for the in-campaign-reuse exception in the send-time anti-join).
--   2. offer_exposures      — one row per (contact, offer); first campaign.
--      Feeds the optional per-campaign include/exclude filter + the offer counter.
--   3. offer_exposure_counts — O(1) "N distinct leads used for this offer".
--
-- Both ledgers are populated WRITE-TIME by a trigger on stage_sends when a row
-- reaches status='sent' (the only per-recipient success marker — see the brief's
-- accepted blind spot: pure external-CSV sends create no stage_sends rows and so
-- leave no exposure trace). The trigger fires from EVERY path that sets 'sent'
-- (send drain + result poller), so no code path can bypass the ledger.
--
-- Dedup is ORG-SCOPED and intentionally spans brands: contacts and creatives are
-- brand-agnostic, so a lead who saw a creative under one brand is correctly
-- suppressed under another. No brand_id on any table here, by design.
--
-- RLS follows the 0085 precedent: org-scoped SELECT policy, NO write policies —
-- every write goes through the server's privileged connection (and the trigger
-- functions are SECURITY DEFINER), which bypasses RLS. App-level org_id
-- filtering remains the primary defense.

-- ============ Tables ============
CREATE TABLE public.creative_exposures (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL,
  contact_id    uuid NOT NULL,
  creative_id   integer NOT NULL,
  -- NULLABLE + ON DELETE SET NULL (NOT cascade): campaign_id is load-bearing for
  -- the in-campaign-reuse exception in the eligibility anti-join
  -- (campaign_id <> currentCampaignId), not metadata. If the originating campaign
  -- is ever hard-deleted, CASCADE would wipe the exposure row and silently make
  -- those contacts re-eligible for a creative they already received — a hole in
  -- the core guarantee. SET NULL keeps the row; Phase 2's layer-1 clause becomes
  -- (campaign_id IS NULL OR campaign_id <> currentCampaignId) so an orphaned row
  -- suppresses unconditionally (a deleted campaign can never be "current").
  campaign_id   integer,
  first_sent_at timestamptz NOT NULL,
  CONSTRAINT creative_exposures_org_id_organizations_id_fk
    FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT creative_exposures_contact_id_contacts_id_fk
    FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE,
  CONSTRAINT creative_exposures_creative_id_creatives_id_fk
    FOREIGN KEY (creative_id) REFERENCES public.creatives(id) ON DELETE CASCADE,
  CONSTRAINT creative_exposures_campaign_id_campaigns_id_fk
    FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE SET NULL,
  CONSTRAINT creative_exposures_org_contact_creative_uniq
    UNIQUE (org_id, contact_id, creative_id)
);--> statement-breakpoint

-- Anti-join driver: suppression set for ONE creative, probed by contact.
CREATE INDEX creative_exposures_org_creative_contact_idx
  ON public.creative_exposures (org_id, creative_id, contact_id);--> statement-breakpoint

CREATE TABLE public.offer_exposures (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL,
  contact_id    uuid NOT NULL,
  offer_id      integer NOT NULL,
  -- NULLABLE + ON DELETE SET NULL — same rationale as creative_exposures.campaign_id
  -- above: preserve the exposure row if the originating campaign is hard-deleted.
  campaign_id   integer,
  first_sent_at timestamptz NOT NULL,
  CONSTRAINT offer_exposures_org_id_organizations_id_fk
    FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT offer_exposures_contact_id_contacts_id_fk
    FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE,
  CONSTRAINT offer_exposures_offer_id_offers_id_fk
    FOREIGN KEY (offer_id) REFERENCES public.offers(id) ON DELETE CASCADE,
  CONSTRAINT offer_exposures_campaign_id_campaigns_id_fk
    FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE SET NULL,
  CONSTRAINT offer_exposures_org_contact_offer_uniq
    UNIQUE (org_id, contact_id, offer_id)
);--> statement-breakpoint

CREATE INDEX offer_exposures_org_offer_contact_idx
  ON public.offer_exposures (org_id, offer_id, contact_id);--> statement-breakpoint

CREATE TABLE public.offer_exposure_counts (
  org_id            uuid NOT NULL,
  offer_id          integer NOT NULL,
  distinct_contacts bigint NOT NULL DEFAULT 0,
  CONSTRAINT offer_exposure_counts_pkey PRIMARY KEY (org_id, offer_id),
  CONSTRAINT offer_exposure_counts_org_id_organizations_id_fk
    FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT offer_exposure_counts_offer_id_offers_id_fk
    FOREIGN KEY (offer_id) REFERENCES public.offers(id) ON DELETE CASCADE
);--> statement-breakpoint

-- ============ RLS (0085 precedent: org-scoped SELECT, no write policies) ============
ALTER TABLE public.creative_exposures ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_exposures ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offer_exposure_counts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "creative_exposures_select_own_org"
  ON public.creative_exposures FOR SELECT
  USING (org_id = public.current_org_id());--> statement-breakpoint

CREATE POLICY "offer_exposures_select_own_org"
  ON public.offer_exposures FOR SELECT
  USING (org_id = public.current_org_id());--> statement-breakpoint

CREATE POLICY "offer_exposure_counts_select_own_org"
  ON public.offer_exposure_counts FOR SELECT
  USING (org_id = public.current_org_id());--> statement-breakpoint

-- ============ Population trigger: stage_sends → both ledgers on 'sent' ============
-- Resolves the creative via the stage and the offer via the campaign (neither is
-- stored on stage_sends). Both inserts are ON CONFLICT DO NOTHING so the first
-- successful send permanently owns the campaign_id ("first sender wins"). A stage whose
-- creative was deleted (creative_id SET NULL) is skipped for the creative ledger
-- but still recorded against the offer (offer is resolved via campaign).
CREATE OR REPLACE FUNCTION public.record_exposure_on_sent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_creative_id integer;
  v_offer_id    integer;
  v_first_at    timestamptz := COALESCE(NEW.sent_at, now());
BEGIN
  SELECT creative_id INTO v_creative_id
  FROM public.campaign_stages WHERE id = NEW.stage_id;

  SELECT offer_id INTO v_offer_id
  FROM public.campaigns WHERE id = NEW.campaign_id;

  IF v_creative_id IS NOT NULL THEN
    INSERT INTO public.creative_exposures
      (org_id, contact_id, creative_id, campaign_id, first_sent_at)
    VALUES
      (NEW.org_id, NEW.contact_id, v_creative_id, NEW.campaign_id, v_first_at)
    ON CONFLICT (org_id, contact_id, creative_id) DO NOTHING;
  END IF;

  IF v_offer_id IS NOT NULL THEN
    INSERT INTO public.offer_exposures
      (org_id, contact_id, offer_id, campaign_id, first_sent_at)
    VALUES
      (NEW.org_id, NEW.contact_id, v_offer_id, NEW.campaign_id, v_first_at)
    ON CONFLICT (org_id, contact_id, offer_id) DO NOTHING;
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

-- Two narrow triggers sharing one function. INSERT covers a row born 'sent';
-- UPDATE OF status covers the normal pending→…→sent transition. The WHEN guards
-- keep it from firing on the many other stage_sends writes (sending, sale
-- attribution, offer-reach, retries, …).
DROP TRIGGER IF EXISTS stage_sends_after_sent_insert ON public.stage_sends;--> statement-breakpoint
CREATE TRIGGER stage_sends_after_sent_insert
  AFTER INSERT ON public.stage_sends
  FOR EACH ROW
  WHEN (NEW.status = 'sent')
  EXECUTE FUNCTION public.record_exposure_on_sent();--> statement-breakpoint

DROP TRIGGER IF EXISTS stage_sends_after_sent_update ON public.stage_sends;--> statement-breakpoint
CREATE TRIGGER stage_sends_after_sent_update
  AFTER UPDATE OF status ON public.stage_sends
  FOR EACH ROW
  WHEN (NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent')
  EXECUTE FUNCTION public.record_exposure_on_sent();--> statement-breakpoint

-- ============ Counter trigger: offer_exposures → offer_exposure_counts ============
-- Fires only on genuinely-new (org, contact, offer) rows (the offer_exposures
-- insert is ON CONFLICT DO NOTHING), so every fire is one new distinct lead.
-- Mirrors the segment_stats.total_count junction-trigger pattern.
CREATE OR REPLACE FUNCTION public.bump_offer_exposure_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.offer_exposure_counts (org_id, offer_id, distinct_contacts)
  VALUES (NEW.org_id, NEW.offer_id, 1)
  ON CONFLICT (org_id, offer_id) DO UPDATE
    SET distinct_contacts = offer_exposure_counts.distinct_contacts + 1;
  RETURN NULL;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS offer_exposures_after_insert_count ON public.offer_exposures;--> statement-breakpoint
CREATE TRIGGER offer_exposures_after_insert_count
  AFTER INSERT ON public.offer_exposures
  FOR EACH ROW EXECUTE FUNCTION public.bump_offer_exposure_count();
