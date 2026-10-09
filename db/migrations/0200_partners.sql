-- Migration 0200: the partner ENTITY (partner attribution, Phase 1).
--
-- Until now the only partner identity was partner_keys: one row = one intake
-- credential AND the partner. The signed report link, the revenue toggle, the
-- counters and every report row hung off partner_key_id. A partner with two
-- keys, or a partner who delivers files and has no key at all, could not be
-- expressed. This creates `partners` above `partner_keys`.
--
-- ⚠️ ADDITIVE, AND THE COLUMN STAYS NULLABLE (owner ruling C2, 2026-10-08).
-- Code deployed after this always writes partner_keys.partner_id; a follow-up
-- migration adds SET NOT NULL once prod reads 0 NULLs. Additive leads code.
--
-- ⚠️ THE TOKEN HASH IS COPIED VERBATIM FROM THE KEY (ruling Q10). The plaintext
-- of a report link is unrecoverable by construction, so moving the link to the
-- partner is the ONLY way to keep pml's live link alive. The four token columns
-- and report_show_revenue stay on partner_keys as dead copies until a later
-- destructive migration drops them (additive leads, destructive follows).
--
-- ⚠️ partner_keys_org_slug_uniq IS DROPPED: two keys of one partner share the
-- partner's slug (partner_keys.partner_slug stays as a denormalized copy for
-- lead_inbox / lead_events provenance). The uniqueness lives on
-- partners(org_id, slug) now. Replaced by a plain index for slug lookups.
-- Checked 2026-10-09 (F5): no application code looks a key up by slug and
-- assumes one row — intake resolves by token, the report and the digest join
-- by id, enrichment reads the slug denormalized on each lead.
--
-- Leads the batch: the lock is held for milliseconds on 4 rows, but a reader
-- queued behind ACCESS EXCLUSIVE must fail fast rather than sit.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE public.partners (
  id                      serial PRIMARY KEY,
  org_id                  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  slug                    text NOT NULL,
  name                    text NOT NULL,
  status                  text NOT NULL DEFAULT 'active',
  archived_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  -- Signed report link, moved here from partner_keys (0172). Same contract:
  -- SHA-256 at rest, plaintext shown once, NULL = no link.
  report_token_hash       text,
  report_token_issued_at  timestamptz,
  report_token_expires_at timestamptz,
  report_show_revenue     boolean NOT NULL DEFAULT false,
  CONSTRAINT partners_status_check CHECK (status IN ('active', 'archived')),
  -- Same shape the key validator enforces; the slug is stamped onto every lead.
  CONSTRAINT partners_slug_check CHECK (slug ~ '^[a-z0-9][a-z0-9_-]*$')
);
--> statement-breakpoint

CREATE UNIQUE INDEX partners_org_slug_uniq ON public.partners (org_id, slug);
--> statement-breakpoint

CREATE UNIQUE INDEX partners_report_token_hash_uniq
  ON public.partners (report_token_hash)
  WHERE report_token_hash IS NOT NULL;
--> statement-breakpoint

CREATE INDEX partners_org_status_idx ON public.partners (org_id, status);
--> statement-breakpoint

-- Tenant table => RLS enabled WITH an org-scoped SELECT policy, never
-- policy-less. Mirrors 0152. No write policies: every writer is the server's
-- privileged connection, which bypasses RLS.
ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "partners_select_own_org"
  ON public.partners FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

ALTER TABLE public.partner_keys
  ADD COLUMN partner_id integer REFERENCES public.partners(id) ON DELETE RESTRICT;
--> statement-breakpoint

CREATE INDEX partner_keys_partner_id_idx ON public.partner_keys (partner_id);
--> statement-breakpoint

-- Backfill: one partner per existing key, in key order so ids are stable
-- (prod: 15 internal-test, 77 pml, 78 docs-curl-verify, 81 bsd). Idempotent:
-- re-running creates nothing for a slug that already has a partner.
INSERT INTO public.partners
  (org_id, slug, name, status, created_at, created_by,
   report_token_hash, report_token_issued_at, report_token_expires_at, report_show_revenue)
SELECT k.org_id, k.partner_slug, k.name, 'active', k.created_at, k.created_by,
       k.report_token_hash, k.report_token_issued_at, k.report_token_expires_at, k.report_show_revenue
FROM public.partner_keys k
WHERE NOT EXISTS (SELECT 1 FROM public.partners p WHERE p.org_id = k.org_id AND p.slug = k.partner_slug)
ORDER BY k.id;
--> statement-breakpoint

UPDATE public.partner_keys k
SET partner_id = p.id
FROM public.partners p
WHERE p.org_id = k.org_id AND p.slug = k.partner_slug AND k.partner_id IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS public.partner_keys_org_slug_uniq;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS partner_keys_org_slug_idx ON public.partner_keys (org_id, partner_slug);
