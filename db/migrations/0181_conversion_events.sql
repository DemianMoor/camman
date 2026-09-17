-- 0181 conversion_events — one row per Keitaro conversion, so a click can carry
-- several events (registration $0, purchase, later deposit/upsell) instead of
-- stage_sends' single latest-wins sale. Plus the org's event-type registry and
-- the per-network / per-offer mapping from Keitaro conversion TYPE to
-- (event type, lifecycle status). Additive only; nothing reads these yet.
-- Recon: docs/superpowers/specs/2026-09-17-multi-event-conversions-recon.md
-- Plan:  docs/superpowers/plans/2026-09-17-conversion-events-phase1.md

CREATE TABLE IF NOT EXISTS public.event_types (
  id serial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  label text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  -- Counts toward "purchased" (tier, segment purchase rules, drip close).
  is_purchase boolean NOT NULL DEFAULT false,
  -- Its revenue counts toward Revenue / EPC (approved status only, Phase 3).
  counts_revenue boolean NOT NULL DEFAULT false,
  -- Feeds the behavioural "Registered – not purchased" style lane (Phase 4).
  is_retarget_signal boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_types_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT event_types_key_format_check CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT event_types_org_key_uniq UNIQUE (org_id, key)
);
--> statement-breakpoint
ALTER TABLE public.event_types ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "event_types_select_own_org"
  ON public.event_types FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint
-- Keitaro conversion TYPE (lowercased Keitaro conversion_type name: lead, sale,
-- rejected, trash, registration, deposit) → (event type, lifecycle status),
-- scoped to ONE network or ONE offer. An offer rule beats a network rule. No
-- rule ⇒ the conversion is stored with NULL event type + status (alerted in
-- Phase 2) and is never a purchase. event_type_id NULL on a rule means "status
-- transition only — keep the row's existing event type" (used for Affise
-- rejected, which can decline either a registration or a purchase).
CREATE TABLE IF NOT EXISTS public.conversion_event_mappings (
  id serial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  affiliate_network_id integer REFERENCES public.affiliate_networks(id) ON DELETE CASCADE,
  offer_id integer REFERENCES public.offers(id) ON DELETE CASCADE,
  keitaro_type text NOT NULL,
  event_type_id integer REFERENCES public.event_types(id) ON DELETE RESTRICT,
  conversion_status text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversion_event_mappings_scope_check
    CHECK (num_nonnulls(affiliate_network_id, offer_id) = 1),
  CONSTRAINT conversion_event_mappings_conversion_status_check
    CHECK (conversion_status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT conversion_event_mappings_status_check
    CHECK (status IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS conversion_event_mappings_network_type_uniq
  ON public.conversion_event_mappings (affiliate_network_id, keitaro_type)
  WHERE affiliate_network_id IS NOT NULL AND status = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS conversion_event_mappings_offer_type_uniq
  ON public.conversion_event_mappings (offer_id, keitaro_type)
  WHERE offer_id IS NOT NULL AND status = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_event_mappings_org_idx
  ON public.conversion_event_mappings (org_id);
--> statement-breakpoint
ALTER TABLE public.conversion_event_mappings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "conversion_event_mappings_select_own_org"
  ON public.conversion_event_mappings FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint
-- One row per Keitaro conversion. keitaro_event_id is Keitaro's per-conversion
-- id: STABLE across in-place updates (a hold→approved or a re-post bumps
-- Keitaro's `version`, not the id — measured 2026-09-17), and a different tid
-- on the same click is a different conversion with its own id.
CREATE TABLE IF NOT EXISTS public.conversion_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  keitaro_event_id text NOT NULL,
  tid text,
  keitaro_click_subid text,
  -- Raw resolved Keitaro status and its canonical conversion type (mapping key).
  keitaro_status text NOT NULL,
  keitaro_type text NOT NULL,
  keitaro_version integer,
  keitaro_offer_id integer,
  -- Attribution. SET NULL (not cascade): deleting a contact or campaign must
  -- never erase revenue history.
  stage_send_id uuid REFERENCES public.stage_sends(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  campaign_id integer REFERENCES public.campaigns(id) ON DELETE SET NULL,
  stage_id integer REFERENCES public.campaign_stages(id) ON DELETE SET NULL,
  offer_id integer REFERENCES public.offers(id) ON DELETE SET NULL,
  -- NULL event_type_id or NULL status = unmapped: stored, alerted, never counted.
  -- event_type_id is LOCKED once set (an update never changes it).
  event_type_id integer REFERENCES public.event_types(id) ON DELETE RESTRICT,
  status text,
  -- Set when a later Keitaro type maps to a DIFFERENT event type than the
  -- locked one (e.g. Registration → Sale on a reused tid): the event type the
  -- latest mapping names, and when the disagreement was first seen. Cleared
  -- when a mapping agrees again. Monitored (Phase 2) — never silently kept.
  conflicting_event_type_id integer REFERENCES public.event_types(id) ON DELETE RESTRICT,
  event_type_conflict_at timestamptz,
  revenue numeric(12, 4) NOT NULL DEFAULT 0,
  currency text,
  -- The ORIGINAL conversion time (earliest status_history entry). Never moved
  -- by an update — Keitaro moves its own `datetime` to the latest re-post.
  occurred_at timestamptz NOT NULL,
  last_postback_at timestamptz,
  status_history text,
  raw_params jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversion_events_status_check
    CHECK (status IS NULL OR status IN ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS conversion_events_keitaro_event_id_uniq
  ON public.conversion_events (keitaro_event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_org_idx
  ON public.conversion_events (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_campaign_event_idx
  ON public.conversion_events (campaign_id, event_type_id, contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_contact_event_idx
  ON public.conversion_events (contact_id, event_type_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_offer_event_occurred_idx
  ON public.conversion_events (offer_id, event_type_id, occurred_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_stage_occurred_idx
  ON public.conversion_events (stage_id, occurred_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_stage_send_idx
  ON public.conversion_events (stage_send_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_unmapped_idx
  ON public.conversion_events (org_id, created_at)
  WHERE event_type_id IS NULL OR status IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_type_conflict_idx
  ON public.conversion_events (org_id, event_type_conflict_at)
  WHERE conflicting_event_type_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.conversion_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "conversion_events_select_own_org"
  ON public.conversion_events FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint
-- Keitaro's offer id (e.g. Psycho Book = 41), so a conversion with no resolvable
-- click can still be attributed to a CamMan offer. offers.offer_id is a short
-- code ('psb'), not Keitaro's id.
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS keitaro_offer_id integer;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS offers_org_keitaro_offer_id_uniq
  ON public.offers (org_id, keitaro_offer_id)
  WHERE keitaro_offer_id IS NOT NULL;
--> statement-breakpoint
-- Seed: every org gets purchase + registration.
INSERT INTO public.event_types
  (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
SELECT o.id, v.key, v.label, v.display_order, v.is_purchase, v.counts_revenue, v.is_retarget_signal
FROM public.organizations o
CROSS JOIN (VALUES
  ('purchase', 'Purchase', 10, true, true, false),
  ('registration', 'Registration', 20, false, false, true)
) AS v(key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
ON CONFLICT (org_id, key) DO NOTHING;
--> statement-breakpoint
-- Seed: network-level mappings, resolved by network CODE (a missing code — e.g.
-- on the preview DB — inserts nothing). Recorded decisions 2026-09-17:
--   swp Sweeply  — template hardcodes status=lead for PAID conversions
--   scc Secco    — Everflow template status={status}; only `sale` observed
--   psb PsychoBook (Affise, Keitaro network #5) — the advertiser can only send
--                  status=lead or status=sale, via two separate postback URLs:
--                  lead = REGISTRATION ($0), sale = paid purchase (sent only
--                  after payment, no hold). NOT the Affise lead=pending pattern.
--                  registration (Keitaro built-in type) seeded too, harmless if
--                  never used; rejected = status-only (keeps the event type)
--   pl  Property Leads — Keitaro network #4 exists (bare postback template, no
--                  status mapping, zero conversions as of 2026-09-17); seeded
--                  with today's treatment — lead-gen CPA, the lead is payable
INSERT INTO public.conversion_event_mappings
  (org_id, affiliate_network_id, keitaro_type, event_type_id, conversion_status)
SELECT n.org_id, n.id, v.keitaro_type, et.id, v.conversion_status
FROM (VALUES
  ('pl',  'lead',         'purchase',     'approved'),
  ('pl',  'sale',         'purchase',     'approved'),
  ('pl',  'rejected',     'purchase',     'rejected'),
  ('swp', 'lead',         'purchase',     'approved'),
  ('swp', 'rejected',     'purchase',     'rejected'),
  ('scc', 'sale',         'purchase',     'approved'),
  ('scc', 'rejected',     'purchase',     'rejected'),
  ('psb', 'lead',         'registration', 'approved'),
  ('psb', 'sale',         'purchase',     'approved'),
  ('psb', 'rejected',     NULL,           'rejected'),
  ('psb', 'registration', 'registration', 'approved')
) AS v(network_code, keitaro_type, event_key, conversion_status)
JOIN public.affiliate_networks n ON n.network_id = v.network_code
LEFT JOIN public.event_types et ON et.org_id = n.org_id AND et.key = v.event_key
ON CONFLICT DO NOTHING;
