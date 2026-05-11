CREATE TABLE "affiliate_networks" (
	"id" serial PRIMARY KEY NOT NULL,
	"network_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"avatar_url" text,
	"color" text,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_networks_network_id_unique" UNIQUE("network_id"),
	CONSTRAINT "affiliate_networks_status_check" CHECK ("affiliate_networks"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" serial PRIMARY KEY NOT NULL,
	"offer_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"postfix" text,
	"base_url" text,
	"network_id" integer,
	"payout_model" text DEFAULT 'cpa' NOT NULL,
	"payout_cpa" numeric(12, 4),
	"payout_revshare" numeric(5, 2),
	"sales_pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"avatar_url" text,
	"color" text,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offers_offer_id_unique" UNIQUE("offer_id"),
	CONSTRAINT "offers_status_check" CHECK ("offers"."status" IN ('active', 'archived')),
	CONSTRAINT "offers_payout_model_check" CHECK ("offers"."payout_model" IN ('cpa', 'revshare'))
);
--> statement-breakpoint
ALTER TABLE "affiliate_networks" ADD CONSTRAINT "affiliate_networks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_network_id_affiliate_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."affiliate_networks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "affiliate_networks_org_id_idx" ON "affiliate_networks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "offers_org_id_idx" ON "offers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "offers_network_id_idx" ON "offers" USING btree ("network_id");