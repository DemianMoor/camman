-- Q1. Let a sending number choose which short domain its links are minted under.
--
-- Today the domain is resolved from the campaign's BRAND. That is the right
-- default and stays the fallback, but it cannot express "this number sends under
-- a different host" — which is what a per-number reputation split needs, and
-- what the g.* hostnames were provisioned for.
--
-- STRICTLY ADDITIVE. One nullable FK. NULL means "no per-number override, use
-- the brand default", which is every existing row: behaviour is unchanged for
-- all of them, and that is asserted by scripts/verify-per-phone-domain.ts before
-- this ships.
--
-- ON DELETE SET NULL, deliberately NOT CASCADE. Removing a short domain must
-- never delete a provider_phone — the number is the expensive, externally
-- provisioned thing; the domain assignment is cheap metadata. Falling back to
-- the brand default is the correct degradation.
--
-- No org_id column here: provider_phones already carries one, and the
-- application resolves both sides org-scoped. The FK is to short_domains(id),
-- whose own org_id is checked at assignment time in the API layer.
ALTER TABLE public.provider_phones
  ADD COLUMN IF NOT EXISTS short_domain_id integer
  REFERENCES public.short_domains(id) ON DELETE SET NULL;
--> statement-breakpoint
-- Partial index: only the minority of numbers that override will be non-NULL,
-- and the lookup is always "given this phone, which domain" (a PK fetch) or the
-- reverse "is this domain still referenced" when an operator tries to remove one.
CREATE INDEX IF NOT EXISTS provider_phones_short_domain_id_idx
  ON public.provider_phones (short_domain_id)
  WHERE short_domain_id IS NOT NULL;
