CREATE TABLE "clickers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"phone_number" text NOT NULL,
	"brand_id" integer NOT NULL,
	"provider_id" integer,
	"provider_phone_id" integer,
	"offer_id" integer,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opt_ins" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"phone_number" text NOT NULL,
	"brand_id" integer,
	"provider_id" integer,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opt_out_brands" (
	"opt_out_id" integer NOT NULL,
	"brand_id" integer NOT NULL,
	CONSTRAINT "opt_out_brands_pkey" UNIQUE("opt_out_id","brand_id")
);
--> statement-breakpoint
CREATE TABLE "opt_out_providers" (
	"opt_out_id" integer NOT NULL,
	"provider_id" integer NOT NULL,
	CONSTRAINT "opt_out_providers_pkey" UNIQUE("opt_out_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "opt_outs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"phone_number" text NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clickers" ADD CONSTRAINT "clickers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clickers" ADD CONSTRAINT "clickers_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clickers" ADD CONSTRAINT "clickers_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clickers" ADD CONSTRAINT "clickers_provider_id_sms_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sms_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clickers" ADD CONSTRAINT "clickers_provider_phone_id_provider_phones_id_fk" FOREIGN KEY ("provider_phone_id") REFERENCES "public"."provider_phones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clickers" ADD CONSTRAINT "clickers_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_ins" ADD CONSTRAINT "opt_ins_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_ins" ADD CONSTRAINT "opt_ins_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_ins" ADD CONSTRAINT "opt_ins_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_ins" ADD CONSTRAINT "opt_ins_provider_id_sms_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sms_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_out_brands" ADD CONSTRAINT "opt_out_brands_opt_out_id_opt_outs_id_fk" FOREIGN KEY ("opt_out_id") REFERENCES "public"."opt_outs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_out_brands" ADD CONSTRAINT "opt_out_brands_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_out_providers" ADD CONSTRAINT "opt_out_providers_opt_out_id_opt_outs_id_fk" FOREIGN KEY ("opt_out_id") REFERENCES "public"."opt_outs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_out_providers" ADD CONSTRAINT "opt_out_providers_provider_id_sms_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sms_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_outs" ADD CONSTRAINT "opt_outs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_outs" ADD CONSTRAINT "opt_outs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clickers_org_id_idx" ON "clickers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "clickers_contact_id_idx" ON "clickers" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "clickers_phone_number_idx" ON "clickers" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX "clickers_brand_id_idx" ON "clickers" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "clickers_provider_id_idx" ON "clickers" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "clickers_offer_id_idx" ON "clickers" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "opt_ins_org_id_idx" ON "opt_ins" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "opt_ins_contact_id_idx" ON "opt_ins" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "opt_ins_phone_number_idx" ON "opt_ins" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX "opt_ins_brand_id_idx" ON "opt_ins" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "opt_ins_provider_id_idx" ON "opt_ins" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "opt_out_brands_brand_id_idx" ON "opt_out_brands" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "opt_out_providers_provider_id_idx" ON "opt_out_providers" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "opt_outs_org_id_idx" ON "opt_outs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "opt_outs_contact_id_idx" ON "opt_outs" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "opt_outs_phone_number_idx" ON "opt_outs" USING btree ("phone_number");