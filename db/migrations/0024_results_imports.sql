CREATE TABLE "result_import_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"sms_provider_id" integer NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"mapping" jsonb NOT NULL,
	"status_value_map" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_result_rows" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"import_id" integer NOT NULL,
	"stage_id" integer NOT NULL,
	"phone_number" text NOT NULL,
	"contact_id" uuid,
	"outcome" text NOT NULL,
	"cost" numeric(12, 4),
	"raw_row" jsonb,
	"created_opt_out_id" integer,
	"created_clicker_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_result_rows_stage_phone_unique" UNIQUE("stage_id","phone_number"),
	CONSTRAINT "stage_result_rows_outcome_check" CHECK ("stage_result_rows"."outcome" IN ('delivered', 'failed', 'optout', 'clicker', 'noop'))
);
--> statement-breakpoint
CREATE TABLE "stage_results_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" integer NOT NULL,
	"stage_id" integer NOT NULL,
	"imported_by_user_id" uuid,
	"mapping_id" integer,
	"filename" text,
	"submitted_rows" integer NOT NULL,
	"processed_rows" integer NOT NULL,
	"delivered_added" integer DEFAULT 0 NOT NULL,
	"failed_added" integer DEFAULT 0 NOT NULL,
	"optouts_added" integer DEFAULT 0 NOT NULL,
	"clickers_added" integer DEFAULT 0 NOT NULL,
	"total_cost_added" numeric(12, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reverted_at" timestamp with time zone,
	"reverted_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "result_import_mappings" ADD CONSTRAINT "result_import_mappings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_import_mappings" ADD CONSTRAINT "result_import_mappings_sms_provider_id_sms_providers_id_fk" FOREIGN KEY ("sms_provider_id") REFERENCES "public"."sms_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_result_rows" ADD CONSTRAINT "stage_result_rows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_result_rows" ADD CONSTRAINT "stage_result_rows_import_id_stage_results_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."stage_results_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_result_rows" ADD CONSTRAINT "stage_result_rows_stage_id_campaign_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."campaign_stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_result_rows" ADD CONSTRAINT "stage_result_rows_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_result_rows" ADD CONSTRAINT "stage_result_rows_created_opt_out_id_opt_outs_id_fk" FOREIGN KEY ("created_opt_out_id") REFERENCES "public"."opt_outs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_result_rows" ADD CONSTRAINT "stage_result_rows_created_clicker_id_clickers_id_fk" FOREIGN KEY ("created_clicker_id") REFERENCES "public"."clickers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_results_imports" ADD CONSTRAINT "stage_results_imports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_results_imports" ADD CONSTRAINT "stage_results_imports_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_results_imports" ADD CONSTRAINT "stage_results_imports_stage_id_campaign_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."campaign_stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_results_imports" ADD CONSTRAINT "stage_results_imports_imported_by_user_id_users_id_fk" FOREIGN KEY ("imported_by_user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_results_imports" ADD CONSTRAINT "stage_results_imports_mapping_id_result_import_mappings_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."result_import_mappings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_results_imports" ADD CONSTRAINT "stage_results_imports_reverted_by_user_id_users_id_fk" FOREIGN KEY ("reverted_by_user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "result_import_mappings_org_provider_idx" ON "result_import_mappings" USING btree ("org_id","sms_provider_id");--> statement-breakpoint
CREATE INDEX "stage_result_rows_import_id_idx" ON "stage_result_rows" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "stage_result_rows_stage_outcome_idx" ON "stage_result_rows" USING btree ("stage_id","outcome");--> statement-breakpoint
CREATE INDEX "stage_results_imports_org_stage_created_idx" ON "stage_results_imports" USING btree ("org_id","stage_id","created_at");--> statement-breakpoint
-- Only one default mapping per (org, provider). Partial unique index;
-- Drizzle doesn't express this natively so it's appended here.
CREATE UNIQUE INDEX "result_import_mappings_default_unique" ON "result_import_mappings" ("org_id","sms_provider_id") WHERE "is_default" = true;