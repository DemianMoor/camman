-- Provider short codes: 5–6 digit numeric SMS short codes attached to a
-- provider. Mirrors provider_phones (cost_per_sms, optional brand, 4-state
-- status) but with a `short_code` identifier instead of a phone number.
--
-- Uniqueness is per-org on the code itself. Soft-delete via status='archived'.

CREATE TABLE public.provider_short_codes (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "provider_id" integer NOT NULL,
  "brand_id" integer,
  "short_code" text NOT NULL,
  "cost_per_sms" numeric(12, 4) DEFAULT '0' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_short_codes_org_id_short_code_unique" UNIQUE("org_id","short_code"),
  CONSTRAINT "provider_short_codes_status_check" CHECK ("provider_short_codes"."status" IN ('active', 'suspended', 'blocked', 'archived'))
);
--> statement-breakpoint

ALTER TABLE public.provider_short_codes
  ADD CONSTRAINT "provider_short_codes_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES public.organizations("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE public.provider_short_codes
  ADD CONSTRAINT "provider_short_codes_provider_id_sms_providers_id_fk"
  FOREIGN KEY ("provider_id") REFERENCES public.sms_providers("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE public.provider_short_codes
  ADD CONSTRAINT "provider_short_codes_brand_id_brands_id_fk"
  FOREIGN KEY ("brand_id") REFERENCES public.brands("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "provider_short_codes_provider_id_idx" ON public.provider_short_codes USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "provider_short_codes_brand_id_idx" ON public.provider_short_codes USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "provider_short_codes_org_id_idx" ON public.provider_short_codes USING btree ("org_id");--> statement-breakpoint

-- RLS: org-scoped select for any member; manager+ for insert/update.
-- Soft-delete only — no DELETE policy. Mirrors provider_phones (0005).
ALTER TABLE public.provider_short_codes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "provider_short_codes_select_own_org"
  ON public.provider_short_codes
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "provider_short_codes_insert_manager_or_higher"
  ON public.provider_short_codes
  FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = provider_short_codes.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
--> statement-breakpoint

CREATE POLICY "provider_short_codes_update_manager_or_higher"
  ON public.provider_short_codes
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = provider_short_codes.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  )
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = provider_short_codes.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager')
    )
  );
