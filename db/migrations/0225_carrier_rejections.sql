-- 0225 — Carrier-rejected numbers: ledger + settings (ClickUp 1amdve2850v). ADDITIVE ONLY; ships dark.
--
-- carrier_rejections       one row per REJECTED MESSAGE (stage_send) from the
--                          txr / Ahoi / Tells delivery receipts, classified hard|soft
--                          by lib/carrier-rejection/codes.ts. TextHub is excluded.
-- carrier_phone_delivery   per (org, phone): sent_at of the latest DELIVERED
--                          message. A delivery resets the phone's counts.
-- carrier_rejected_phones  per (org, phone): the numbers that currently meet the
--                          rule, with their counts. Computed whether or not the
--                          toggle is on; eligibility reads it only when it is.
--
-- org_settings: the toggle (default OFF) and the three thresholds.
--
-- NOT AN OPT-OUT. Nothing here touches opt_outs. The only writers are the
-- carrier-rejections cron (15-min incremental + daily rebuild) via
-- lib/carrier-rejection/ledger.ts, on the server connection — so RLS grants
-- members SELECT only.
--
-- Constant defaults on the ALTERs: metadata-only, no rewrite. The brief ACCESS
-- EXCLUSIVE lock on org_settings and the FK reference lock on stage_sends are
-- why lock_timeout leads the batch.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS carrier_rejection_suppression_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS carrier_rejection_hard_threshold smallint NOT NULL DEFAULT 2;
--> statement-breakpoint
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS carrier_rejection_soft_threshold smallint NOT NULL DEFAULT 3;
--> statement-breakpoint
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS carrier_rejection_soft_window_days smallint NOT NULL DEFAULT 30;
--> statement-breakpoint
ALTER TABLE public.org_settings DROP CONSTRAINT IF EXISTS org_settings_carrier_rejection_thresholds_check;
--> statement-breakpoint
ALTER TABLE public.org_settings ADD CONSTRAINT org_settings_carrier_rejection_thresholds_check CHECK (
  carrier_rejection_hard_threshold BETWEEN 1 AND 100
  AND carrier_rejection_soft_threshold BETWEEN 1 AND 100
  AND carrier_rejection_soft_window_days BETWEEN 1 AND 365
);
--> statement-breakpoint
COMMENT ON COLUMN public.org_settings.carrier_rejection_suppression_enabled IS
  'Carrier-rejected numbers (0225): when on, numbers in carrier_rejected_phones are excluded from new audiences, drip routing and stage materialization. Not an opt-out; off = eligible again, no data lost.';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.carrier_rejections (
  stage_send_id uuid PRIMARY KEY REFERENCES public.stage_sends(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  phone text NOT NULL,
  provider text NOT NULL CONSTRAINT carrier_rejections_provider_check CHECK (provider IN ('txr', 'ahi', 'tls')),
  severity text NOT NULL CONSTRAINT carrier_rejections_severity_check CHECK (severity IN ('hard', 'soft')),
  code text NOT NULL,
  -- The MESSAGE's sent_at (stage_sends.sent_at), not the receipt's: the soft
  -- window and the delivered-reset both order messages by when they were sent.
  sent_at timestamptz NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS carrier_rejections_org_phone_sent_idx
  ON public.carrier_rejections (org_id, phone, sent_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.carrier_phone_delivery (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  phone text NOT NULL,
  last_delivered_sent_at timestamptz NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, phone)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.carrier_rejected_phones (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  phone text NOT NULL,
  hard_count integer NOT NULL,
  -- Soft rejections inside the org's soft window, as of evaluated_at.
  soft_count integer NOT NULL,
  last_rejected_at timestamptz NOT NULL,
  last_code text NOT NULL,
  last_provider text NOT NULL,
  -- First time the number entered the set in its current streak.
  flagged_at timestamptz NOT NULL DEFAULT now(),
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, phone)
);
--> statement-breakpoint
ALTER TABLE public.carrier_rejections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.carrier_phone_delivery ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.carrier_rejected_phones ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "carrier_rejections_select_own_org" ON public.carrier_rejections;
--> statement-breakpoint
CREATE POLICY "carrier_rejections_select_own_org" ON public.carrier_rejections
  FOR SELECT USING (org_id = public.current_org_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "carrier_phone_delivery_select_own_org" ON public.carrier_phone_delivery;
--> statement-breakpoint
CREATE POLICY "carrier_phone_delivery_select_own_org" ON public.carrier_phone_delivery
  FOR SELECT USING (org_id = public.current_org_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "carrier_rejected_phones_select_own_org" ON public.carrier_rejected_phones;
--> statement-breakpoint
CREATE POLICY "carrier_rejected_phones_select_own_org" ON public.carrier_rejected_phones
  FOR SELECT USING (org_id = public.current_org_id());
