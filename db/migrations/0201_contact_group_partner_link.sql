-- Migration 0201: contact group → partner link (partner attribution Phase 2).
--
-- Leads the batch. The appearance repair is NOT here (owner fix F1): it is
-- scripts/repair-drip-membership-appearance.ts, run on its own go after the
-- enrichment code that stamps delivery time is deployed.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- ── C2, finished: partner_keys.partner_id becomes NOT NULL ──────────────────
-- Prod read 0 NULLs of 4 on 2026-10-09 after the 0200 backfill, and every code
-- path that inserts a key has written it since (#329). The guard makes the
-- apply fail loudly instead of SET NOT NULL failing on an opaque row.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.partner_keys WHERE partner_id IS NULL) THEN
    RAISE EXCEPTION '0201: partner_keys.partner_id has NULL rows — assign them before SET NOT NULL';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE public.partner_keys ALTER COLUMN partner_id SET NOT NULL;
--> statement-breakpoint

-- ── R1: the link lives on the group ─────────────────────────────────────────
-- ⚠️ On a drip partner×tag group (contact_group_id LIKE 'drip:%') ONLY the
-- pipeline sets it (owner fix F3): ensurePartnerTagGroup at creation, and the
-- backfill below. The group screen shows it read-only there.
ALTER TABLE public.contact_groups
  ADD COLUMN partner_id integer REFERENCES public.partners(id) ON DELETE RESTRICT;
--> statement-breakpoint

CREATE INDEX contact_groups_org_partner_idx
  ON public.contact_groups (org_id, partner_id) WHERE partner_id IS NOT NULL;
--> statement-breakpoint

-- ── C4: the system drip groups carry an explicit marker, never a hard-coded id
ALTER TABLE public.contact_groups ADD COLUMN system_role text;
--> statement-breakpoint

ALTER TABLE public.contact_groups
  ADD CONSTRAINT contact_groups_system_role_check
  CHECK (system_role IS NULL OR system_role IN ('drip_intake', 'drip_sandbox'));
--> statement-breakpoint

-- A pipeline artifact is not an acquisition source: it can never be a partner entry.
ALTER TABLE public.contact_groups
  ADD CONSTRAINT contact_groups_system_not_partner_check
  CHECK (system_role IS NULL OR partner_id IS NULL);
--> statement-breakpoint

UPDATE public.contact_groups
SET system_role = CASE contact_group_id WHEN 'drip-intake' THEN 'drip_intake' ELSE 'drip_sandbox' END
WHERE contact_group_id IN ('drip-intake', 'drip-sandbox') AND system_role IS NULL;
--> statement-breakpoint

-- ── Q6: link the existing drip partner×tag groups to their partner ──────────
-- The group name is partnerTagGroupName(slug, tag) = '<slug>-<tag>'. Exact
-- prefix comparison (F4): `_` is a LIKE wildcard and slugs allow it. Slugs may
-- contain '-', so the LONGEST matching slug in the org wins ('ab-cd-x' belongs
-- to 'ab-cd', not 'ab'). Idempotent: partner_id IS NULL only. Prod (F5 exit
-- check asserts exactly these): pml-aca → pml, bsd-untagged → bsd.
UPDATE public.contact_groups g
SET partner_id = p.id
FROM public.partners p
WHERE g.org_id = p.org_id
  AND g.contact_group_id LIKE 'drip:%'
  AND g.partner_id IS NULL AND g.system_role IS NULL
  AND left(g.name, length(p.slug) + 1) = p.slug || '-'
  AND NOT EXISTS (
    SELECT 1 FROM public.partners p2
    WHERE p2.org_id = g.org_id AND p2.id <> p.id
      AND left(g.name, length(p2.slug) + 1) = p2.slug || '-'
      AND length(p2.slug) > length(p.slug));
--> statement-breakpoint

-- ── §5.3: the recalc job table (consumed by Phase 3's cron; written from Phase 2's PATCH)
CREATE TABLE public.partner_attribution_recalcs (
  id               bigserial PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_group_id integer NOT NULL REFERENCES public.contact_groups(id) ON DELETE CASCADE,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  requested_by     uuid,
  reason           text NOT NULL,
  status           text NOT NULL DEFAULT 'queued',
  campaigns_total  integer,
  campaigns_done   integer NOT NULL DEFAULT 0,
  started_at       timestamptz,
  finished_at      timestamptz,
  error            text,
  CONSTRAINT partner_attribution_recalcs_reason_check CHECK (reason IN ('link', 'unlink', 'relink', 'manual')),
  CONSTRAINT partner_attribution_recalcs_status_check CHECK (status IN ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint

CREATE INDEX partner_attribution_recalcs_org_status_idx
  ON public.partner_attribution_recalcs (org_id, status, requested_at);
--> statement-breakpoint

CREATE INDEX partner_attribution_recalcs_group_idx
  ON public.partner_attribution_recalcs (contact_group_id);
--> statement-breakpoint

ALTER TABLE public.partner_attribution_recalcs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "partner_attribution_recalcs_select_own_org"
  ON public.partner_attribution_recalcs FOR SELECT
  USING (org_id = public.current_org_id());
