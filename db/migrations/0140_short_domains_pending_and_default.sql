-- B1. Brand short domains: a `pending` status, a DB-enforced per-brand default,
-- and the three provisioned g.* hostnames inserted UNACTIVATED.
--
-- ⚠️ ACTIVATION IS NOT PART OF THIS MIGRATION, deliberately. The new rows land
-- `status='pending'`, which no send path can mint under: kickoff's short-domain
-- resolution has always required `status='active'` (both the per-phone override
-- and the brand branch), and preflight's "Active short domain" check likewise.
-- So this migration provisions rows and changes NO behaviour. Activation is the
-- operator's hands-on acceptance, gated on a live probe through the domain
-- actually reaching the app.
--
-- ⚠️ Brands 142 (LumZen) and 143 (FitsYou) have NO active short domain at all
-- today — only brand 8 (gdkn.org) does — so a tracked campaign on them refuses
-- with `no_short_domain`. Activating g.lumzen.co / g.fitsyou.net therefore
-- ENABLES TRACKED SENDING FOR THOSE BRANDS FOR THE FIRST TIME. Acceptance needs
-- one tracked campaign per newly-activated brand, not just a domain probe.

-- 1. `pending` joins the status vocabulary. Widening a CHECK is additive; no
--    existing row changes, and every existing consumer filters on 'active'.
ALTER TABLE public.short_domains
  DROP CONSTRAINT short_domains_status_check;
--> statement-breakpoint
-- 'active'   — mintable.
-- 'pending'  — provisioned, NOT yet proven to route to the app. Never mintable.
-- 'archived' — retired.
ALTER TABLE public.short_domains
  ADD CONSTRAINT short_domains_status_check
  CHECK (status IN ('active', 'pending', 'archived'));
--> statement-breakpoint

-- 2. An explicit per-brand default.
--
-- Migration 0136 allowed a brand more than one short domain, which left the
-- brand-level pick as "oldest active" — deterministic, but implicit and
-- unstateable by the operator. This column makes the choice explicit and
-- reviewable while keeping the old rule as the fallback.
ALTER TABLE public.short_domains
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- 3. AT MOST ONE default per brand, enforced by the DATABASE.
--
-- A partial unique index rather than a trigger or an FK on brands: it is the
-- cheapest enforcement, it cannot be bypassed by any write path, and it keeps
-- the domain list self-describing (the flag lives on the row it describes).
--
-- It enforces AT MOST one, which is the enforceable half — a brand with zero
-- short domains cannot be made to have a default, and brands 142/143 are in
-- exactly that state until an operator activates theirs. "Exactly one" is
-- delivered by resolution, not by the constraint: with no default flagged, the
-- brand branch falls back to the pre-existing oldest-active pick.
CREATE UNIQUE INDEX IF NOT EXISTS short_domains_one_default_per_brand
  ON public.short_domains (org_id, brand_id)
  WHERE is_default;
--> statement-breakpoint

-- 4. Backfill the flag to the domain the CURRENT rule already picks, so
--    resolution is byte-identical the moment the new branch goes live.
--
-- `DISTINCT ON (org_id, brand_id) … ORDER BY created_at, id` is the exact
-- ordering lib/sends/kickoff.ts uses for the brand branch today. Restricted to
-- status='active' for the same reason. Today this flags precisely one row
-- (gdkn.org, id 15); written as a set operation rather than a hardcoded id so it
-- is correct in any environment, including the demo database.
UPDATE public.short_domains d
SET is_default = true
FROM (
  SELECT DISTINCT ON (org_id, brand_id) id
  FROM public.short_domains
  WHERE status = 'active'
  ORDER BY org_id, brand_id, created_at ASC, id ASC
) pick
WHERE d.id = pick.id;
--> statement-breakpoint

-- 5. The three provisioned hostnames, as `pending`.
--
-- Brands are matched by their business code (`brands.brand_id`), never a
-- hardcoded numeric id, so this is correct in any environment and a no-op where
-- a brand is absent. `ON CONFLICT (org_id, domain) DO NOTHING` makes it
-- idempotent — re-running changes nothing, and it can never flip an
-- already-activated row back to pending.
--
-- is_default stays false: a pending domain must never be a brand's default, or
-- activating it later would silently move minting for the whole brand.
INSERT INTO public.short_domains (org_id, brand_id, domain, status, is_default)
SELECT b.org_id, b.id, v.domain, 'pending', false
FROM public.brands b
JOIN (VALUES
  ('gdkn', 'g.guidekn.com'),
  ('lmzn', 'g.lumzen.co'),
  ('fty',  'g.fitsyou.net')
) AS v(brand_code, domain) ON v.brand_code = b.brand_id
ON CONFLICT (org_id, domain) DO NOTHING;
