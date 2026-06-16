-- Append-only per-attempt send evidence (Workstream 3, Guarantee 2). One row per
-- TextHub send attempt, written by the drain right after each HTTP call.
--
-- WHY a separate table: stage_sends.last_error is OVERWRITTEN on retry, which
-- destroys the first attempt's evidence. stage_sends stays the current-state row;
-- send_attempts is the immutable history. It captures the VERBATIM response body
-- (TextHub's HTTP codes are unreliable, so the body is the real evidence), the
-- normalized result, and the assigned classification (mine/theirs/indeterminate).
--
-- The request is stored already-redacted (api_key never persisted — see the
-- guardrails in the brief and maskApiKey). This table is the source for the
-- one-click escalation export keyed by texthub_message_id.
CREATE TABLE public.send_attempts (
  id               bigserial PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  stage_send_id    uuid NOT NULL REFERENCES public.stage_sends(id) ON DELETE CASCADE,
  attempt_number   integer NOT NULL,
  -- The exact request, with the api_key already redacted before storage.
  request_redacted text,
  http_status      integer NOT NULL,
  raw_body         text,
  ok               boolean NOT NULL,
  message_id       text,
  error            text,
  -- accepted | mine_transport | theirs_rejected | indeterminate (see
  -- lib/sends/classify-attempt.ts). Free-text + CHECK so a new bucket is a small
  -- migration, not silent drift.
  classification   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT send_attempts_classification_check CHECK (
    classification IN ('accepted', 'mine_transport', 'theirs_rejected', 'indeterminate')
  )
);
--> statement-breakpoint

CREATE INDEX send_attempts_stage_send_idx
  ON public.send_attempts (stage_send_id, created_at);
--> statement-breakpoint
CREATE INDEX send_attempts_org_id_idx ON public.send_attempts (org_id, created_at);
--> statement-breakpoint

-- RLS: org-scoped reads (Activity drill-down / escalation export UI). Writes go
-- through the app's privileged connection inside the drain, so no authenticated
-- write policy (mirrors send_circuit_events / campaign_events).
ALTER TABLE public.send_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "send_attempts_select_own_org"
  ON public.send_attempts FOR SELECT
  USING (org_id = public.current_org_id());
