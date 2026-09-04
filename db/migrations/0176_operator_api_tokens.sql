-- Operator API tokens for Claude access (ClickUp 869evpmbz, Phase 1) — the ONE
-- additive migration for this card.
--
-- Nothing here changes existing behaviour on its own. The added column defaults
-- to FALSE (API off for everyone, including the Owner), and all three new
-- tables ship EMPTY.
--
-- ⚠️ "Ships empty" is a fact about today, not a guard. Do not write a check that
--    asserts these tables are empty or that api_enabled is false everywhere — it
--    would go red the first time the feature is used correctly
--    (docs/07-conventions.md, "A guard that goes red on correct use is a
--    countdown").
--
-- Used by:
--   api_tokens            — bearer auth inside requireApiMembership()
--   api_token_usage       — the per-token hourly rate limiter and denial counter
--   audience_fresh_counts — the rollup behind GET /api/audience/fresh-counts
--
-- RLS: all three new tables get RLS ENABLED plus an org-scoped SELECT policy,
-- mirroring 0175 and every other tenant table, so the security advisor's
-- coverage does not regress. Defence-in-depth only — the app's own connection
-- runs as `postgres` with rolbypassrls = true, so the real gate is application
-- code (can(role, 'users.manage') for issuance, the token allowlist for reads).

-- ── org_members.api_enabled ────────────────────────────────────────────────
-- The per-user API on/off switch, INDEPENDENT of is_active. Defaults FALSE so
-- applying this migration grants nothing to anyone: every existing member —
-- Owner included — has API access off until an Owner turns it on deliberately.
-- That is the opposite default from is_active (which defaulted TRUE to preserve
-- existing behaviour) and it is the right one here, because this column is
-- creating a capability rather than describing one that already existed.
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS api_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- ── api_tokens ─────────────────────────────────────────────────────────────
-- A personal bearer token bound to ONE membership. It is not a second identity:
-- it resolves to the owning member's org_id + role and then rides the exact same
-- gate a session does (is_active, the operator route map, can(), redactForRole).
--
-- ⚠️ FK IS org_member_id, NOT user_id. The token's authority IS the membership,
-- so the two must live and die together: removing someone from the org must take
-- their tokens with it, and ON DELETE CASCADE is what makes that structural
-- rather than a cleanup step someone has to remember. It also lets the auth
-- resolver fetch token + org_id + role + is_active + api_enabled in ONE join,
-- matching the single round-trip getApiMembershipRow() already costs.
--
-- ⚠️ token_hash IS THE ONLY COPY. The plaintext is shown once at creation and
-- never stored, so a database dump yields nothing usable. SHA-256, not bcrypt —
-- see lib/api/tokens.ts for why a slow KDF is wrong for a 256-bit random secret.
CREATE TABLE IF NOT EXISTS public.api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  org_member_id uuid NOT NULL
    REFERENCES public.org_members(id) ON DELETE CASCADE,
  -- SHA-256 hex of the plaintext token. Unique so a (vanishingly unlikely)
  -- collision is a write error rather than two tokens resolving to one row.
  token_hash text NOT NULL,
  -- The leading, NON-SECRET characters of the token ("cmt_3f9a…"), so the Owner
  -- can tell two tokens apart in the UI and match a usage-log row to a token
  -- without the plaintext ever being retrievable.
  token_prefix text NOT NULL,
  name text NOT NULL
    CONSTRAINT api_tokens_name_not_blank CHECK (length(btrim(name)) > 0),
  -- Read-only is the DEFAULT and, for this card, the only shape that ships:
  -- what a token may reach is decided by the `token` flag in OPERATOR_ROUTE_MAP,
  -- not by HTTP method. The column exists so a future write-capable token is a
  -- data change rather than a schema change; nothing sets it true today.
  read_only boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_token_hash_uniq
  ON public.api_tokens (token_hash);
--> statement-breakpoint
-- The listing index for /settings/users: every LIVE token for a member.
-- Partial on revoked_at so revoked rows (kept forever as the audit record of
-- what once existed) do not bloat the index the hot path uses.
CREATE INDEX IF NOT EXISTS api_tokens_org_member_live_idx
  ON public.api_tokens (org_id, org_member_id)
  WHERE revoked_at IS NULL;
--> statement-breakpoint
ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "api_tokens_select_own_org"
  ON public.api_tokens FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

-- ── api_token_usage ────────────────────────────────────────────────────────
-- Per-token counters, one row per (token, window kind, window start).
-- Modelled directly on partner_key_usage (Drip Phase 2) because that table is
-- live and its construction is already proven against production.
--
-- ⚠️ THE RATE-LIMIT GUARD BELONGS ON THE `DO UPDATE`, NOT IN APPLICATION CODE.
-- An unconditional increment that the caller compares afterwards means REJECTED
-- REQUESTS BURN QUOTA: a client already over the limit keeps incrementing and
-- locks itself out for the rest of the window without ever succeeding. With
-- `WHERE count + 1 <= limit` on the DO UPDATE, a refusal touches nothing.
-- See lib/api/token-usage.ts, which mirrors lib/intake/rate-limit.ts.
--
-- window_kind is TEXT, not an enum: 'request' is the rate-limited counter and
-- 'denied' is an unbounded tally that must keep counting PAST any threshold so
-- the burst alert can report the real figure.
CREATE TABLE IF NOT EXISTS public.api_token_usage (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  api_token_id uuid NOT NULL
    REFERENCES public.api_tokens(id) ON DELETE CASCADE,
  window_kind text NOT NULL
    CONSTRAINT api_token_usage_window_kind_check
      CHECK (window_kind IN ('request', 'denied')),
  -- Truncated to the hour, in UTC. Both counters are hourly, so unlike
  -- partner_key_usage there is no ET calendar-day boundary to honour here.
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS api_token_usage_token_window_uniq
  ON public.api_token_usage (api_token_id, window_kind, window_start);
--> statement-breakpoint
-- Drives the per-user usage drill-in ("requests over time" for one member's
-- tokens over a date range) without scanning the whole table per token.
CREATE INDEX IF NOT EXISTS api_token_usage_org_window_idx
  ON public.api_token_usage (org_id, window_start);
--> statement-breakpoint
ALTER TABLE public.api_token_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "api_token_usage_select_own_org"
  ON public.api_token_usage FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

-- ── audience_fresh_counts ──────────────────────────────────────────────────
-- The rollup behind GET /api/audience/fresh-counts. One row per org, refreshed
-- by a cron, read by the endpoint. Mirrors contact_org_stats.carrier_breakdown
-- (migration 0145): a JSONB blob computed on a schedule, plus the timestamp the
-- reader needs to state its own staleness.
--
-- ⚠️ WHY A ROLLUP AND NOT A LIVE QUERY. "Not messaged in N days" is an anti-join
-- of the whole eligible contact base against every 'sent' row in the window,
-- per group. That is seconds of work, and the endpoint's caller is an agent that
-- may ask repeatedly. Computing it on a cron makes the cost fixed and
-- independent of how chatty the caller is. `computed_at` travels in the response
-- so the answer is never presented as live.
--
-- ⚠️ THE BLOB STORES EXACTLY WHAT THE ENDPOINT RETURNS — group NAMES and
-- integers, no ids, no phone numbers, no contact fields. Nothing is stripped at
-- the response boundary because there is nothing here to strip. That is
-- deliberate: a redaction step someone can forget is weaker than a payload that
-- never contained the secret.
CREATE TABLE IF NOT EXISTS public.audience_fresh_counts (
  org_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Shape (see lib/audience/fresh-counts.ts for the authoritative type):
  --   { "eligible_total": int,
  --     "not_messaged": { "7d": int, "30d": int },
  --     "by_group": [ { "group_name": text, "total": int,
  --                     "not_messaged": { "7d": int, "30d": int } } ] }
  counts jsonb,
  -- When the numbers were computed. NULL until the first cron run, which is why
  -- the endpoint must handle "no row yet" rather than assume the cron has run.
  computed_at timestamptz,
  -- How long the refresh took. Kept because this is the one query in the card
  -- whose cost can grow with the contact base, and a trend is cheaper to read
  -- here than to reconstruct from logs.
  duration_ms integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.audience_fresh_counts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audience_fresh_counts_select_own_org"
  ON public.audience_fresh_counts FOR SELECT
  USING (org_id = public.current_org_id());
