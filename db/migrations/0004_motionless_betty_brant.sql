CREATE TABLE "provider_phones" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_id" integer NOT NULL,
	"brand_id" integer,
	"phone_number" text NOT NULL,
	"country_code" text,
	"dial_code" text,
	"local_number" text,
	"cost_per_sms" numeric(12, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_phones_org_id_phone_number_unique" UNIQUE("org_id","phone_number"),
	CONSTRAINT "provider_phones_status_check" CHECK ("provider_phones"."status" IN ('active', 'suspended', 'blocked', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "sms_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"sms_provider_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"short_link_supported" boolean DEFAULT false NOT NULL,
	"short_link_example" text,
	"avatar_url" text,
	"color" text,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_providers_sms_provider_id_unique" UNIQUE("sms_provider_id"),
	CONSTRAINT "sms_providers_status_check" CHECK ("sms_providers"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "provider_phones" ADD CONSTRAINT "provider_phones_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_phones" ADD CONSTRAINT "provider_phones_provider_id_sms_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sms_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_phones" ADD CONSTRAINT "provider_phones_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_providers" ADD CONSTRAINT "sms_providers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_phones_provider_id_idx" ON "provider_phones" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "provider_phones_brand_id_idx" ON "provider_phones" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "provider_phones_org_id_idx" ON "provider_phones" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sms_providers_org_id_idx" ON "sms_providers" USING btree ("org_id");