-- Rename and retype campaign_stages.scheduled_date → scheduled_at TIMESTAMPTZ.
-- Existing DATE values are interpreted as midnight in America/New_York; this is the
-- project-wide campaign timezone (see CLAUDE.md "Timezone" subsection).
ALTER TABLE "campaign_stages" RENAME COLUMN "scheduled_date" TO "scheduled_at";
--> statement-breakpoint
ALTER TABLE "campaign_stages"
  ALTER COLUMN "scheduled_at" TYPE TIMESTAMPTZ
  USING ("scheduled_at"::timestamp AT TIME ZONE 'America/New_York');
