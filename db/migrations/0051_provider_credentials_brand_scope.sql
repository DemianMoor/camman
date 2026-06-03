-- Brand-scope provider API credentials so several accounts/keys can coexist
-- across providers AND brands (each brand can use its own provider account).
--
-- Was: UNIQUE(provider_id) — exactly one key per provider.
-- Now: a key per (provider_id, brand_id), with brand_id NULL = a provider-wide
-- default used when a brand has no key of its own. Send-time resolution prefers
-- the brand-specific key, then falls back to the default.

ALTER TABLE public.provider_credentials
  DROP CONSTRAINT provider_credentials_provider_id_key;
--> statement-breakpoint

ALTER TABLE public.provider_credentials
  ADD COLUMN brand_id integer REFERENCES public.brands(id) ON DELETE CASCADE;
--> statement-breakpoint

-- Set on every write (insert + rotate) so the UI can show "last updated".
ALTER TABLE public.provider_credentials
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint

-- One key per (provider, brand). NULL brand_ids are distinct under a plain
-- unique index, so the provider-default uniqueness is enforced separately below.
CREATE UNIQUE INDEX provider_credentials_provider_brand_uniq
  ON public.provider_credentials (provider_id, brand_id);
--> statement-breakpoint

-- At most one provider-default (brand_id IS NULL) per provider.
CREATE UNIQUE INDEX provider_credentials_provider_default_uniq
  ON public.provider_credentials (provider_id)
  WHERE brand_id IS NULL;
--> statement-breakpoint

CREATE INDEX provider_credentials_brand_id_idx
  ON public.provider_credentials (brand_id);
