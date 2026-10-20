-- 0216: message formats (P2 of docs/superpowers/specs/2026-10-19-message-personalization-formats-design.md §B/§D).
-- Additive only.
--   message_formats              org-level templates: blocks {brand} {creative_text}
--                                {url} {stop_text} + <new_row>. One default per org.
--   ensure_message_formats(org)  seeds T1 (default) / T2 / T3 for an org with none;
--                                returns the default id.
--   campaign_stages.message_format_id / custom_text
--                                exactly one is set (CHECK). Existing stages -> T1
--                                (T1 is byte-identical to the pre-format body).
--                                A BEFORE INSERT trigger fills the org default when
--                                both are NULL, so the base create path, new orgs and
--                                the raw-SQL test fixtures keep working.
--   stage_sends.message_format_id / format_custom
--                                per-send stamp (audit + exact sent counts). No FK:
--                                the hot insert path stays light.
-- Seed text MUST equal lib/messages/format.ts SEED_FORMATS (asserted by
-- scripts/test-message-formats-db.ts).
-- stage_sends is ALTERed LAST so its ACCESS EXCLUSIVE lock is held for the
-- shortest time before COMMIT.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.message_formats (
  id          serial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  template    text NOT NULL,
  is_enabled  boolean NOT NULL DEFAULT true,
  is_default  boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'active',
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_formats_status_check CHECK (status IN ('active', 'archived')),
  -- The default is always usable: enabled and not archived.
  CONSTRAINT message_formats_default_usable_check CHECK (NOT is_default OR (is_enabled AND status = 'active'))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS message_formats_org_default_uniq
  ON public.message_formats (org_id) WHERE is_default;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS message_formats_org_status_idx
  ON public.message_formats (org_id, status);--> statement-breakpoint

-- Tenant table => RLS enabled WITH an org-scoped SELECT policy (0200 pattern).
-- No write policies: every writer is the server's privileged connection.
ALTER TABLE public.message_formats ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "message_formats_select_own_org" ON public.message_formats;--> statement-breakpoint
CREATE POLICY "message_formats_select_own_org"
  ON public.message_formats FOR SELECT
  USING (org_id = public.current_org_id());--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ensure_message_formats(p_org uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_id integer;
BEGIN
  SELECT id INTO v_id FROM public.message_formats WHERE org_id = p_org AND is_default;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  -- Serialize seeding per org: two concurrent first stage inserts must not seed twice.
  PERFORM pg_advisory_xact_lock(hashtext('message_formats:' || p_org::text));
  SELECT id INTO v_id FROM public.message_formats WHERE org_id = p_org AND is_default;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.message_formats WHERE org_id = p_org) THEN
    RAISE EXCEPTION 'message_formats: org % has formats but no default', p_org;
  END IF;
  INSERT INTO public.message_formats (org_id, name, template, is_default)
  VALUES (p_org, 'T1 — Brand prefix', '{brand}: {creative_text}<new_row>{url}<new_row>{stop_text}', true)
  RETURNING id INTO v_id;
  INSERT INTO public.message_formats (org_id, name, template, is_default) VALUES
    (p_org, 'T2 — Brand inline', '{creative_text} {brand} {stop_text}<new_row><new_row>{url}', false),
    (p_org, 'T3 — Brand in creative', '{creative_text}<new_row>{url}<new_row>{stop_text}', false);
  RETURN v_id;
END;
$$;--> statement-breakpoint

SELECT public.ensure_message_formats(o.id) FROM public.organizations o;--> statement-breakpoint

ALTER TABLE public.campaign_stages
  ADD COLUMN IF NOT EXISTS message_format_id integer REFERENCES public.message_formats(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS custom_text text;--> statement-breakpoint

-- Backfill: every existing stage renders T1 (= the pre-format body). campaign_stages
-- has no UPDATE trigger, so this changes nothing else.
UPDATE public.campaign_stages
   SET message_format_id = public.ensure_message_formats(org_id)
 WHERE message_format_id IS NULL AND custom_text IS NULL;--> statement-breakpoint

ALTER TABLE public.campaign_stages DROP CONSTRAINT IF EXISTS campaign_stages_format_one_of;--> statement-breakpoint
ALTER TABLE public.campaign_stages
  ADD CONSTRAINT campaign_stages_format_one_of CHECK ((message_format_id IS NULL) <> (custom_text IS NULL));--> statement-breakpoint

CREATE INDEX IF NOT EXISTS campaign_stages_message_format_idx
  ON public.campaign_stages (message_format_id) WHERE message_format_id IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.campaign_stages_fill_message_format()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.message_format_id IS NULL AND NEW.custom_text IS NULL THEN
    NEW.message_format_id := public.ensure_message_formats(NEW.org_id);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS campaign_stages_fill_message_format ON public.campaign_stages;--> statement-breakpoint
CREATE TRIGGER campaign_stages_fill_message_format
  BEFORE INSERT ON public.campaign_stages
  FOR EACH ROW EXECUTE FUNCTION public.campaign_stages_fill_message_format();--> statement-breakpoint

COMMENT ON TABLE public.message_formats IS
  'Message format templates (0216): how {brand}/{creative_text}/{url}/{stop_text} assemble into the SMS body. One default per org. Rendered by lib/messages/render.ts.';--> statement-breakpoint

ALTER TABLE public.stage_sends
  ADD COLUMN IF NOT EXISTS message_format_id integer,
  ADD COLUMN IF NOT EXISTS format_custom boolean NOT NULL DEFAULT false;
