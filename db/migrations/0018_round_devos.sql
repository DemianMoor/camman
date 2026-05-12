CREATE TABLE "creatives" (
	"id" serial PRIMARY KEY NOT NULL,
	"creative_id" text,
	"slug" text NOT NULL,
	"org_id" uuid NOT NULL,
	"offer_id" integer NOT NULL,
	"sms_provider_id" integer,
	"brand_id" integer,
	"text" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creatives_creative_id_unique" UNIQUE("creative_id"),
	CONSTRAINT "creatives_slug_unique" UNIQUE("slug"),
	CONSTRAINT "creatives_status_check" CHECK ("creatives"."status" IN ('draft', 'pending', 'ready', 'paused', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_sms_provider_id_sms_providers_id_fk" FOREIGN KEY ("sms_provider_id") REFERENCES "public"."sms_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creatives_org_id_idx" ON "creatives" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "creatives_offer_id_idx" ON "creatives" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "creatives_sms_provider_id_idx" ON "creatives" USING btree ("sms_provider_id");--> statement-breakpoint
CREATE INDEX "creatives_brand_id_idx" ON "creatives" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "creatives_status_idx" ON "creatives" USING btree ("status");