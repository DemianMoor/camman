CREATE TABLE "segment_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"segment_group_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_groups_segment_group_id_unique" UNIQUE("segment_group_id"),
	CONSTRAINT "segment_groups_status_check" CHECK ("segment_groups"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "utm_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"tag_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"value_source" text NOT NULL,
	"affiliate_network_id" integer,
	"color" text,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "utm_tags_tag_id_unique" UNIQUE("tag_id"),
	CONSTRAINT "utm_tags_status_check" CHECK ("utm_tags"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "segment_groups" ADD CONSTRAINT "segment_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utm_tags" ADD CONSTRAINT "utm_tags_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utm_tags" ADD CONSTRAINT "utm_tags_affiliate_network_id_affiliate_networks_id_fk" FOREIGN KEY ("affiliate_network_id") REFERENCES "public"."affiliate_networks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "segment_groups_org_id_idx" ON "segment_groups" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "utm_tags_org_id_idx" ON "utm_tags" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "utm_tags_affiliate_network_id_idx" ON "utm_tags" USING btree ("affiliate_network_id");