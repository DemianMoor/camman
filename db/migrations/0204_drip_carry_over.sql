-- 0204: drip carry-over ("Send leads"). Additive. Leads the code that reads it.
-- Spec: docs/superpowers/specs/2026-10-12-drip-carry-over-design.md
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "drip_carry_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "drip_admission_widened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_drip_carry_days_check";--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_drip_carry_days_check"
  CHECK ("drip_carry_days" >= 0 AND "drip_carry_days" <= 7);--> statement-breakpoint
ALTER TABLE "drip_campaign_configs" ADD COLUMN IF NOT EXISTS "carry_days" integer;--> statement-breakpoint
ALTER TABLE "drip_campaign_configs" ADD COLUMN IF NOT EXISTS "admission_widened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drip_campaign_configs" DROP CONSTRAINT IF EXISTS "drip_campaign_configs_carry_days_check";--> statement-breakpoint
ALTER TABLE "drip_campaign_configs" ADD CONSTRAINT "drip_campaign_configs_carry_days_check"
  CHECK ("carry_days" IS NULL OR ("carry_days" >= 0 AND "carry_days" <= 7));--> statement-breakpoint
-- The ADD COLUMN with a constant default is metadata-only on PG ≥ 11 (no rewrite), but the
-- CHECK below validates with a full scan of drip_journeys (sub-second at ~63K rows; use
-- NOT VALID + VALIDATE CONSTRAINT if the table grows).
ALTER TABLE "drip_journeys" ADD COLUMN IF NOT EXISTS "carried_days" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "drip_journeys" DROP CONSTRAINT IF EXISTS "drip_journeys_carried_days_check";--> statement-breakpoint
ALTER TABLE "drip_journeys" ADD CONSTRAINT "drip_journeys_carried_days_check" CHECK ("carried_days" >= 0);--> statement-breakpoint
-- ⭐ widened_at is stamped HERE, for every writer (API, SQL, duplicate route),
-- whenever the effective admission window gets LONGER. Leads that arrived
-- before it are same-day only — that is what keeps already-skipped leads out.
CREATE OR REPLACE FUNCTION drip_org_admission_widened() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.drip_carry_days * 1440 + NEW.drip_admission_cutoff_minutes > 0 THEN
      NEW.drip_admission_widened_at := now();
    END IF;
  ELSIF NEW.drip_carry_days * 1440 + NEW.drip_admission_cutoff_minutes
      > OLD.drip_carry_days * 1440 + OLD.drip_admission_cutoff_minutes THEN
    NEW.drip_admission_widened_at := now();
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "org_settings_drip_admission_widened" ON "org_settings";--> statement-breakpoint
CREATE TRIGGER "org_settings_drip_admission_widened"
  BEFORE INSERT OR UPDATE OF "drip_carry_days", "drip_admission_cutoff_minutes" ON "org_settings"
  FOR EACH ROW EXECUTE FUNCTION drip_org_admission_widened();--> statement-breakpoint
CREATE OR REPLACE FUNCTION drip_cfg_admission_widened() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o_carry integer := 0;
  o_cut integer := 0;
  new_w integer;
  old_w integer := 0;
BEGIN
  SELECT os.drip_carry_days, os.drip_admission_cutoff_minutes INTO o_carry, o_cut
  FROM org_settings os WHERE os.org_id = NEW.org_id;
  o_carry := COALESCE(o_carry, 0);
  o_cut := COALESCE(o_cut, 0);
  new_w := COALESCE(NEW.carry_days, o_carry) * 1440 + COALESCE(NEW.admission_cutoff_minutes, o_cut);
  IF TG_OP = 'UPDATE' THEN
    old_w := COALESCE(OLD.carry_days, o_carry) * 1440 + COALESCE(OLD.admission_cutoff_minutes, o_cut);
  END IF;
  IF new_w > old_w THEN
    NEW.admission_widened_at := now();
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "drip_campaign_configs_admission_widened" ON "drip_campaign_configs";--> statement-breakpoint
CREATE TRIGGER "drip_campaign_configs_admission_widened"
  BEFORE INSERT OR UPDATE OF "carry_days", "admission_cutoff_minutes" ON "drip_campaign_configs"
  FOR EACH ROW EXECUTE FUNCTION drip_cfg_admission_widened();
