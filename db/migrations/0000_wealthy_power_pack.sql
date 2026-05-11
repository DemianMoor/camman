CREATE TABLE "brands" (
	"id" serial PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"short_link_base" text,
	"avatar_url" text,
	"color" text,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_brand_id_unique" UNIQUE("brand_id"),
	CONSTRAINT "brands_status_check" CHECK ("brands"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token" text NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_unique" UNIQUE("token"),
	CONSTRAINT "invites_role_check" CHECK ("invites"."role" IN ('admin', 'manager', 'operator', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"role" text NOT NULL,
	"invited_by" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_user_org_unique" UNIQUE("user_id","org_id"),
	CONSTRAINT "org_members_role_check" CHECK ("org_members"."role" IN ('owner', 'admin', 'manager', 'operator', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brands_org_id_idx" ON "brands" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "invites_org_id_idx" ON "invites" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "invites_email_idx" ON "invites" USING btree ("email");--> statement-breakpoint
CREATE INDEX "org_members_org_id_idx" ON "org_members" USING btree ("org_id");