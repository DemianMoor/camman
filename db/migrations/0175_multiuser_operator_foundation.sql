-- Multi-user CamMan (ClickUp 869et3vm1) — the ONE additive migration covering
-- schema for phases 1-4. Nothing here changes existing behaviour on its own:
-- every added column is nullable or carries a default that reproduces today's
-- state, and all three new tables ship EMPTY with no reader until the phase
-- that needs them lands.
--
-- ⚠️ "Ships empty" is a fact about today, not a guard. Do not write a check
--    that asserts these tables are empty — it would go red the first time the
--    feature is used correctly (docs/07-conventions.md, "A guard that goes red
--    on correct use is a countdown").
--
-- Phase 1 uses: org_members.is_active / last_login_at / last_login_ip /
--   invited_email / invited_at, and created_by_user_id on campaigns +
--   campaign_stages (the deactivation kill switch has nothing to filter on
--   without them — campaign_events.actor_user_id is an event log, not
--   ownership).
-- Phase 2 uses: provider_route_aliases.
-- Phase 3 uses: deletion_requests.
-- Phase 4 uses: audit_log (written from Phase 1 onward for auth events).
--
-- RLS: all three new tables get RLS ENABLED plus an org-scoped SELECT policy,
-- mirroring every other tenant table, so the 89/89 coverage the security
-- advisor checks does not regress. These policies are ORG-scoped only, NOT
-- role-aware: role-aware RLS is deferred to its own card (Phase 0 decision D).
-- Owner-only visibility for audit_log is enforced in application code via
-- can(role, 'audit.view') — RLS here is defence-in-depth against a leaked anon
-- key, nothing more, because the app's own connection runs as `postgres` with
-- rolbypassrls = true.

-- ── org_members: activation + login telemetry + invite bookkeeping ──────────
-- is_active defaults TRUE so every existing member keeps working the moment
-- this applies. The per-request check added in Phase 1 reads it in the SAME
-- SELECT that already resolves org_id + role, so it costs no extra query.
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
--> statement-breakpoint
-- text, not inet: the value comes from x-forwarded-for, which is a COMMA-
-- SEPARATED LIST when more than one proxy is in front of us, and inet would
-- reject it outright. Matches how clicks.ip already stores the same class of
-- value.
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS last_login_ip text;
--> statement-breakpoint
-- Set when an Owner invites someone who has no auth.users row yet. Once they
-- accept, user_id is filled and this stays as the audit record of the address
-- the invite was sent to.
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS invited_email text;
--> statement-breakpoint
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS invited_at timestamptz;
--> statement-breakpoint

-- ── created_by_user_id: authorship for the deactivation kill switch ─────────
-- ⚠️ campaigns.created_by_user_id ALREADY EXISTS and is already written by
--    POST /api/campaigns and the duplicate route (394 of 397 rows populated as
--    of 2026-08-31). The Phase 0 recon claimed both tables lacked it; that was
--    wrong for campaigns and right for campaign_stages. Only the STAGES column
--    is new here. Verified against information_schema, not against the recon.
--
-- ON DELETE SET NULL, never CASCADE: removing a user must never delete their
-- stages. NULL means "created before this migration" and is expected on every
-- existing row — there is deliberately NO backfill, because authorship cannot
-- be reconstructed after the fact.
ALTER TABLE public.campaign_stages
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid
  REFERENCES auth.users(id) ON DELETE SET NULL;
--> statement-breakpoint
-- Neither table had ANY index on created_by_user_id (checked pg_indexes), and
-- the kill switch's whole job is "what did THIS user create". Partial because
-- pre-existing rows are NULL and will never be the target. Both tables are
-- small today (campaigns 397, campaign_stages 1,466) so these build instantly
-- and need no CONCURRENTLY — but the project targets 100+ campaigns/day, at
-- which point the index is what keeps the kill switch off a seq scan.
CREATE INDEX IF NOT EXISTS campaigns_created_by_idx
  ON public.campaigns (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS campaign_stages_created_by_idx
  ON public.campaign_stages (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;
--> statement-breakpoint

-- ── provider_route_aliases (Phase 2) ───────────────────────────────────────
-- Stable "Route A / B / C…" label per provider ACCOUNT. Owner sees provider
-- name + alias; Operator sees the alias only. credential_id is nullable
-- because a provider with a single account is aliased at the provider level;
-- multi-account providers get one alias per credential.
CREATE TABLE IF NOT EXISTS public.provider_route_aliases (
  id serial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  sms_provider_id integer NOT NULL
    REFERENCES public.sms_providers(id) ON DELETE CASCADE,
  credential_id integer
    REFERENCES public.provider_credentials(id) ON DELETE CASCADE,
  alias text NOT NULL
    CONSTRAINT provider_route_aliases_alias_not_blank
      CHECK (length(btrim(alias)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One alias string per org. This is the property that makes the alias STABLE
-- and therefore usable as an identifier in conversation.
CREATE UNIQUE INDEX IF NOT EXISTS provider_route_aliases_org_alias_uniq
  ON public.provider_route_aliases (org_id, alias);
--> statement-breakpoint
-- Two partial uniques, not one composite: a plain UNIQUE (org_id,
-- sms_provider_id, credential_id) would let UNLIMITED rows through when
-- credential_id IS NULL, because NULL is never equal to NULL in a unique
-- index. Splitting on the null-ness is the only form that actually constrains
-- both shapes.
CREATE UNIQUE INDEX IF NOT EXISTS provider_route_aliases_provider_cred_uniq
  ON public.provider_route_aliases (org_id, sms_provider_id, credential_id)
  WHERE credential_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS provider_route_aliases_provider_only_uniq
  ON public.provider_route_aliases (org_id, sms_provider_id)
  WHERE credential_id IS NULL;
--> statement-breakpoint
ALTER TABLE public.provider_route_aliases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "provider_route_aliases_select_own_org"
  ON public.provider_route_aliases FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

-- ── audit_log (Phase 4, written from Phase 1) ──────────────────────────────
-- Mirrors campaign_events (the existing precedent: org_id + actor_user_id +
-- event_type + summary + jsonb metadata) minus the campaign FKs, plus request
-- context. campaign_events stays as-is and keeps owning campaign-scoped
-- history; this table owns account/authz/compliance events that have no
-- campaign to hang off.
--
-- actor_user_id is ON DELETE SET NULL and NULLABLE on purpose: an audit row
-- must survive the deletion of the user it describes, and some rows have no
-- human actor at all (a cron-driven kill switch, a system deactivation).
CREATE TABLE IF NOT EXISTS public.audit_log (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Dotted machine-readable verb, e.g. 'auth.login', 'user.deactivated',
  -- 'stage.auto_paused', 'creative.cap_hit'. Never render this raw — `summary`
  -- is the human-facing line.
  action text NOT NULL
    CONSTRAINT audit_log_action_not_blank CHECK (length(btrim(action)) > 0),
  entity_type text,
  -- text, not a typed id: this table spans entities whose PKs are variously
  -- serial, uuid and text. Storing the printed form keeps one column.
  entity_id text,
  summary text NOT NULL,
  metadata jsonb,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_org_created_idx
  ON public.audit_log (org_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_org_actor_created_idx
  ON public.audit_log (org_id, actor_user_id, created_at DESC);
--> statement-breakpoint
-- Supports the "login from a new IP" alert, which asks: has this actor used
-- this ip before? Without it that check degrades to a scan of the actor's
-- whole history on every login.
CREATE INDEX IF NOT EXISTS audit_log_org_action_created_idx
  ON public.audit_log (org_id, action, created_at DESC);
--> statement-breakpoint
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_log_select_own_org"
  ON public.audit_log FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

-- ── deletion_requests (Phase 3) ────────────────────────────────────────────
-- Operator asks, Owner decides. Everything except campaigns and stages routes
-- through here rather than deleting directly.
CREATE TABLE IF NOT EXISTS public.deletion_requests (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_type text NOT NULL
    CONSTRAINT deletion_requests_entity_type_not_blank
      CHECK (length(btrim(entity_type)) > 0),
  entity_id text NOT NULL,
  -- Denormalized so the approval queue can still name what it is pointing at
  -- after the entity is archived or renamed.
  entity_label text,
  reason text,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CONSTRAINT deletion_requests_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- The queue reads "pending, newest first"; partial so it stays small as
-- decided rows accumulate.
CREATE INDEX IF NOT EXISTS deletion_requests_org_pending_idx
  ON public.deletion_requests (org_id, created_at DESC)
  WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS deletion_requests_org_created_idx
  ON public.deletion_requests (org_id, created_at DESC);
--> statement-breakpoint
-- One OPEN request per entity. Decided rows are unconstrained, so the same
-- entity can be requested again after a rejection.
CREATE UNIQUE INDEX IF NOT EXISTS deletion_requests_open_entity_uniq
  ON public.deletion_requests (org_id, entity_type, entity_id)
  WHERE status = 'pending';
--> statement-breakpoint
ALTER TABLE public.deletion_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "deletion_requests_select_own_org"
  ON public.deletion_requests FOR SELECT
  USING (org_id = public.current_org_id());
