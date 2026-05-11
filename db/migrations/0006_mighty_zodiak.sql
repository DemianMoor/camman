CREATE TABLE "routing_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"routing_type_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_types_routing_type_id_unique" UNIQUE("routing_type_id"),
	CONSTRAINT "routing_types_status_check" CHECK ("routing_types"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "traffic_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"traffic_type_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traffic_types_traffic_type_id_unique" UNIQUE("traffic_type_id"),
	CONSTRAINT "traffic_types_status_check" CHECK ("traffic_types"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "routing_types" ADD CONSTRAINT "routing_types_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traffic_types" ADD CONSTRAINT "traffic_types_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routing_types_org_id_idx" ON "routing_types" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "traffic_types_org_id_idx" ON "traffic_types" USING btree ("org_id");