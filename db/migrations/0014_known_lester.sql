CREATE TABLE "segment_contacts" (
	"segment_id" integer NOT NULL,
	"contact_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_contacts_pkey" UNIQUE("segment_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "segment_stats" (
	"segment_id" integer PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"opt_out_count" integer DEFAULT 0 NOT NULL,
	"opt_in_count" integer DEFAULT 0 NOT NULL,
	"clicker_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"segment_id" text NOT NULL,
	"name" text NOT NULL,
	"original_name" text,
	"segment_group_id" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segments_segment_id_unique" UNIQUE("segment_id"),
	CONSTRAINT "segments_status_check" CHECK ("segments"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "segment_contacts" ADD CONSTRAINT "segment_contacts_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_contacts" ADD CONSTRAINT "segment_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_contacts" ADD CONSTRAINT "segment_contacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_stats" ADD CONSTRAINT "segment_stats_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_stats" ADD CONSTRAINT "segment_stats_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_segment_group_id_segment_groups_id_fk" FOREIGN KEY ("segment_group_id") REFERENCES "public"."segment_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "segment_contacts_contact_id_idx" ON "segment_contacts" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "segment_contacts_org_id_idx" ON "segment_contacts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "segment_stats_org_id_idx" ON "segment_stats" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "segments_org_id_idx" ON "segments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "segments_segment_group_id_idx" ON "segments" USING btree ("segment_group_id");