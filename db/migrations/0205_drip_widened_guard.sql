-- 0205: drip carry-over follow-up to 0204. No schema change — trigger functions only.
--   1. admission_widened_at stamps are forward-only (a NULL or older value keeps OLD).
--      Test-only escape hatch: SET LOCAL camman.allow_widened_backdate = 'on' (or
--      set_config(..., true)) inside a transaction. Never use it in app code.
--   2. A drip campaign ENTERING active/paused (from draft/completed/archived) stamps
--      its config's admission_widened_at = now(). active <-> paused does not.
-- Re-runnable: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE OR REPLACE FUNCTION drip_org_admission_widened() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.drip_carry_days * 1440 + NEW.drip_admission_cutoff_minutes > 0 THEN
      NEW.drip_admission_widened_at := now();
    END IF;
  ELSE
    IF NEW.drip_carry_days * 1440 + NEW.drip_admission_cutoff_minutes
        > OLD.drip_carry_days * 1440 + OLD.drip_admission_cutoff_minutes THEN
      NEW.drip_admission_widened_at := now();
    END IF;
    -- Forward-only: GREATEST ignores NULLs, so NULLing or backdating keeps OLD.
    IF current_setting('camman.allow_widened_backdate', true) IS DISTINCT FROM 'on' THEN
      NEW.drip_admission_widened_at := GREATEST(OLD.drip_admission_widened_at, NEW.drip_admission_widened_at);
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "org_settings_drip_admission_widened" ON "org_settings";--> statement-breakpoint
CREATE TRIGGER "org_settings_drip_admission_widened"
  BEFORE INSERT OR UPDATE OF "drip_carry_days", "drip_admission_cutoff_minutes", "drip_admission_widened_at" ON "org_settings"
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
  -- Forward-only: GREATEST ignores NULLs, so NULLing or backdating keeps OLD.
  IF TG_OP = 'UPDATE'
     AND current_setting('camman.allow_widened_backdate', true) IS DISTINCT FROM 'on' THEN
    NEW.admission_widened_at := GREATEST(OLD.admission_widened_at, NEW.admission_widened_at);
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "drip_campaign_configs_admission_widened" ON "drip_campaign_configs";--> statement-breakpoint
CREATE TRIGGER "drip_campaign_configs_admission_widened"
  BEFORE INSERT OR UPDATE OF "carry_days", "admission_cutoff_minutes", "admission_widened_at" ON "drip_campaign_configs"
  FOR EACH ROW EXECUTE FUNCTION drip_cfg_admission_widened();--> statement-breakpoint
-- The routing scan only considers active/paused campaigns, so a drip campaign that
-- (re-)enters that set must not floor back to an old stamp: treat it as a widening.
CREATE OR REPLACE FUNCTION drip_campaign_status_widened() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE drip_campaign_configs SET admission_widened_at = now() WHERE campaign_id = NEW.id;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "campaigns_drip_status_widened" ON "campaigns";--> statement-breakpoint
CREATE TRIGGER "campaigns_drip_status_widened"
  AFTER UPDATE OF "status" ON "campaigns"
  FOR EACH ROW
  WHEN (NEW.type = 'drip' AND NEW.status IN ('active', 'paused') AND OLD.status NOT IN ('active', 'paused'))
  EXECUTE FUNCTION drip_campaign_status_widened();
