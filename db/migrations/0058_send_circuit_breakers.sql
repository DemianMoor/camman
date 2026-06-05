-- Spend/harm circuit breakers for the outbound send pipeline (schema only).
--
-- Adds per-provider send caps + a LATCHING pause (the DB-backed mid-run
-- kill-switch + manual panic), an append-only circuit-event audit log, and a
-- structural per-contact dedup guard on stage_sends. No behavior changes until
-- the drain enforces these (next commit); SEND_ENABLED stays off.

-- ── Per-provider caps + latching pause ──────────────────────────────────────
-- max_sends_per_run    : SOFT per-invocation pacing cap. Reaching it leaves rows
--                        'pending' and resumes next tick — it NEVER pauses, so a
--                        100k+ legit audience flows across ticks without
--                        tripping. NULL ⇒ built-in default (1000), hard-clamped
--                        to ABSOLUTE_MAX (2000) in code so a misconfigured huge
--                        value can't defeat pacing.
-- max_sends_per_minute : SOFT rolling-rate ceiling (successful sends/min). NULL
--                        ⇒ default 100. On breach: stop the run, retry next tick
--                        (no pause).
-- max_sends_per_24h    : SOFT rolling 24h ceiling. NULL ⇒ default 10000. On
--                        breach: stop the run (no pause).
--   SCOPE LIMITATION: the 24h/minute counts are evaluated org-wide (indexed on
--   stage_sends.org_id) as a proxy for THIS provider's volume. True daily budget
--   governance is org-wide = SUM across providers; with one provider today the
--   two coincide. REVISIT AT PROVIDER #2 → move the daily ceiling to
--   organizations and count per-provider.
-- send_paused          : LATCHING kill-switch (the DB-backed mid-run kill +
--                        manual panic). Once true, the drain no-ops every batch
--                        for this provider until a human consciously resumes via
--                        the provider UI. Trips ONLY on anomalies: manual panic,
--                        a drain-failure spike, or the structural pacing
--                        tripwire — NOT on the soft pacing/rate/24h ceilings.
ALTER TABLE public.sms_providers
  ADD COLUMN max_sends_per_run    integer,
  ADD COLUMN max_sends_per_minute integer,
  ADD COLUMN max_sends_per_24h    integer,
  ADD COLUMN send_paused          boolean NOT NULL DEFAULT false,
  ADD COLUMN send_paused_reason   text,
  ADD COLUMN send_paused_at       timestamptz;
--> statement-breakpoint

-- ── Append-only circuit-event audit log ─────────────────────────────────────
-- Records every pause (auto-trip = actor_user_id NULL + a system reason; manual
-- panic = actor set) and every resume (actor = the session user who cleared it).
-- Un-pausing after a loop-trip is consequential — this is the permanent who/when
-- record, and doubles as breaker-trip history. actor_user_id is the auth user id
-- stored WITHOUT a cross-schema FK to auth.users (audit log, intentionally
-- decoupled — a deleted user must not cascade away the record).
CREATE TABLE public.send_circuit_events (
  id            bigserial PRIMARY KEY,
  org_id        uuid    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider_id   integer NOT NULL REFERENCES public.sms_providers(id) ON DELETE CASCADE,
  event         text    NOT NULL,
  reason        text,
  actor_user_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT send_circuit_events_event_check CHECK (event IN ('paused', 'resumed'))
);
--> statement-breakpoint

CREATE INDEX send_circuit_events_provider_idx
  ON public.send_circuit_events (provider_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX send_circuit_events_org_id_idx ON public.send_circuit_events (org_id);
--> statement-breakpoint

-- RLS: org-scoped reads (audit display). Writes happen via the privileged role
-- (drain auto-trip + the resume endpoint), so no authenticated write policy.
ALTER TABLE public.send_circuit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "send_circuit_events_select_own_org"
  ON public.send_circuit_events FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

-- ── Breaker #2: structural per-contact dedup ────────────────────────────────
-- Makes "the same contact has two SIMULTANEOUSLY-LIVE sends in one stage"
-- impossible at the DB level, hardening the SELECT-then-INSERT guard in
-- kickoffStageSend against a concurrent-kickoff race. The partial predicate
-- covers only live rows, so it PRESERVES the deliberate designs in 0050: a
-- genuine resend (prior rows already 'sent'/'failed') mints fresh rows without
-- conflict, and id = send_token retry-reuse is unaffected.
CREATE UNIQUE INDEX stage_sends_active_contact_uniq
  ON public.stage_sends (stage_id, contact_id)
  WHERE status IN ('pending', 'sending');
--> statement-breakpoint

-- Keep the rolling-window rate/24h counts cheap (org-scoped, by send time).
CREATE INDEX stage_sends_org_sent_at_idx
  ON public.stage_sends (org_id, sent_at)
  WHERE sent_at IS NOT NULL;
