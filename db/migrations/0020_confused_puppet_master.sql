CREATE TABLE "campaign_audience_pool" (
	"campaign_id" integer NOT NULL,
	"contact_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"was_clicker_at_snapshot" boolean DEFAULT false NOT NULL,
	"was_opt_in_at_snapshot" boolean DEFAULT false NOT NULL,
	"was_no_status_at_snapshot" boolean DEFAULT false NOT NULL,
	CONSTRAINT "campaign_audience_pool_pkey" UNIQUE("campaign_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_stages" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" integer NOT NULL,
	"stage_number" integer NOT NULL,
	"label" text,
	"creative_id" integer,
	"sms_provider_id" integer,
	"provider_phone_id" integer,
	"sales_page_label" text,
	"stop_text" text DEFAULT 'Stop to END' NOT NULL,
	"include_clickers" boolean DEFAULT false NOT NULL,
	"exclude_clickers" boolean DEFAULT false NOT NULL,
	"include_no_status" boolean DEFAULT true NOT NULL,
	"scheduled_date" date,
	"sent_at" timestamp with time zone,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"previous_status" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"sms_count" integer DEFAULT 0 NOT NULL,
	"total_cost" numeric(12, 4) DEFAULT '0' NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"opt_out_count" integer DEFAULT 0 NOT NULL,
	"click_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_stages_campaign_id_stage_number_unique" UNIQUE("campaign_id","stage_number"),
	CONSTRAINT "campaign_stages_status_check" CHECK ("campaign_stages"."status" IN ('draft', 'pending', 'sent', 'success', 'cancelled', 'failed', 'archived')),
	CONSTRAINT "campaign_stages_clickers_mutex" CHECK (NOT ("campaign_stages"."include_clickers" AND "campaign_stages"."exclude_clickers"))
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"human_id" text,
	"name" text NOT NULL,
	"notes" text,
	"brand_id" integer NOT NULL,
	"offer_id" integer NOT NULL,
	"routing_type_id" integer,
	"traffic_type_id" integer,
	"assigned_to_user_id" uuid,
	"created_by_user_id" uuid,
	"audience_segment_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"audience_filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audience_snapshot_count" integer DEFAULT 0 NOT NULL,
	"start_date" date,
	"end_date" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"previous_status" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_org_id_slug_unique" UNIQUE("org_id","slug"),
	CONSTRAINT "campaigns_status_check" CHECK ("campaigns"."status" IN ('draft', 'active', 'paused', 'completed', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "campaign_audience_pool" ADD CONSTRAINT "campaign_audience_pool_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_audience_pool" ADD CONSTRAINT "campaign_audience_pool_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_audience_pool" ADD CONSTRAINT "campaign_audience_pool_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_stages" ADD CONSTRAINT "campaign_stages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_stages" ADD CONSTRAINT "campaign_stages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_stages" ADD CONSTRAINT "campaign_stages_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_stages" ADD CONSTRAINT "campaign_stages_sms_provider_id_sms_providers_id_fk" FOREIGN KEY ("sms_provider_id") REFERENCES "public"."sms_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_stages" ADD CONSTRAINT "campaign_stages_provider_phone_id_provider_phones_id_fk" FOREIGN KEY ("provider_phone_id") REFERENCES "public"."provider_phones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_routing_type_id_routing_types_id_fk" FOREIGN KEY ("routing_type_id") REFERENCES "public"."routing_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_traffic_type_id_traffic_types_id_fk" FOREIGN KEY ("traffic_type_id") REFERENCES "public"."traffic_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_audience_pool_contact_id_idx" ON "campaign_audience_pool" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "campaign_audience_pool_org_id_idx" ON "campaign_audience_pool" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "campaign_stages_org_id_idx" ON "campaign_stages" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "campaign_stages_campaign_id_idx" ON "campaign_stages" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaign_stages_creative_id_idx" ON "campaign_stages" USING btree ("creative_id");--> statement-breakpoint
CREATE INDEX "campaign_stages_sms_provider_id_idx" ON "campaign_stages" USING btree ("sms_provider_id");--> statement-breakpoint
CREATE INDEX "campaign_stages_status_idx" ON "campaign_stages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaigns_org_id_idx" ON "campaigns" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "campaigns_brand_id_idx" ON "campaigns" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "campaigns_offer_id_idx" ON "campaigns" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "campaigns_assigned_to_user_id_idx" ON "campaigns" USING btree ("assigned_to_user_id");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");