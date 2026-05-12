CREATE TABLE "segment_segment_groups" (
	"segment_id" integer NOT NULL,
	"segment_group_id" integer NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_segment_groups_pkey" UNIQUE("segment_id","segment_group_id")
);
--> statement-breakpoint
ALTER TABLE "segments" DROP CONSTRAINT "segments_segment_group_id_segment_groups_id_fk";
--> statement-breakpoint
DROP INDEX "segments_segment_group_id_idx";--> statement-breakpoint
ALTER TABLE "segment_segment_groups" ADD CONSTRAINT "segment_segment_groups_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_segment_groups" ADD CONSTRAINT "segment_segment_groups_segment_group_id_segment_groups_id_fk" FOREIGN KEY ("segment_group_id") REFERENCES "public"."segment_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_segment_groups" ADD CONSTRAINT "segment_segment_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "segment_segment_groups_group_id_idx" ON "segment_segment_groups" USING btree ("segment_group_id");--> statement-breakpoint
CREATE INDEX "segment_segment_groups_org_id_idx" ON "segment_segment_groups" USING btree ("org_id");--> statement-breakpoint
-- Preserve existing single-group memberships into the new junction before
-- dropping the column. Idempotent on conflict (same segment / group pair).
INSERT INTO "segment_segment_groups" ("segment_id", "segment_group_id", "org_id")
  SELECT id, segment_group_id, org_id
  FROM "segments"
  WHERE segment_group_id IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "segments" DROP COLUMN "segment_group_id";