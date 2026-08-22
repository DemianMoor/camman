-- Migration 0154: partner_key_usage + alert_state (Drip Phase 2).
--
-- ============================================================================
-- partner_key_usage — the DB-backed rate limiter
-- ============================================================================
--
-- ⚠️ WHY THIS TABLE EXISTS AT ALL. The only limiter in the codebase,
-- lib/api/rate-limit.ts, is an IN-MEMORY token bucket used by exactly one route
-- (/api/spam/score). Its own header says why it cannot be used here:
--
--   "In a serverless deployment this only enforces per-instance — Vercel
--    spreads requests across cold/warm instances so the effective rate is
--    instance_count * limit... real protection requires shared state."
--
-- A per-partner contractual limit (10 req/s, 50K leads/day) cannot be enforced
-- that way at all. Shared state means the database.
--
-- ⚠️ THE COUNTER IS INCREMENTED BY A GUARDED UPSERT, NOT A BARE ONE.
-- The obvious shape — the one campaign_tracking_counters uses to allocate
-- sequence numbers — ALLOCATES but does not REFUSE:
--
--   INSERT ... VALUES (...) ON CONFLICT (...) DO UPDATE SET count = count + 1
--   RETURNING count
--
-- Used as a limiter that has a real defect: a client hammering while ALREADY
-- over the limit keeps incrementing, so REJECTED REQUESTS BURN THE QUOTA. A
-- partner with a misconfigured retry loop would lock itself out for the rest of
-- the ET day without ever delivering a lead. The fix is a WHERE on the DO
-- UPDATE, so refusal is atomic and costs nothing:
--
--   ON CONFLICT (partner_key_id, window_kind, window_start)
--   DO UPDATE SET count = partner_key_usage.count + $n
--     WHERE partner_key_usage.count + $n <= $limit
--   RETURNING count
--
-- When the guard is false the UPDATE touches nothing and RETURNING yields NO
-- ROW. Zero rows returned => over limit => 429. Measured against production in a
-- rolled-back transaction: allow path 23.50 ms/op against a 24.1 ms bare round
-- trip (i.e. the DB work is within noise of an empty query — the cost is one
-- network hop, ~2 ms from fra1); refuse path returned 0 rows and left the
-- counter unchanged.
--
-- ⚠️ The INSERT branch is NOT covered by that WHERE. The first call of a window
-- takes VALUES ($n) unguarded, so a single oversized batch would be admitted on
-- a cold window. Batch size is therefore validated in the route BEFORE this
-- statement runs; the DB guard alone is bypassable exactly once per window.
--
-- Units differ by window_kind, and this is load-bearing (ruled G14):
--   'sec'       — counts REQUESTS (the burst contract)
--   'day'       — counts LEADS    (the volume contract; a 500-lead batch costs 500)
--   'auth_fail' — counts failed secret checks on a RESOLVED token
--
-- window_start for 'day' is the ET calendar day start as a timestamptz, from
-- campaignDayBoundsUtc() — never a functional predicate on a timestamp, per the
-- sargability convention in docs/07-conventions.md.
--
-- ============================================================================
-- alert_state — state-transition gating
-- ============================================================================
--
-- ⚠️ NO SUCH MECHANISM EXISTS TODAY. notifyTelegram() is best-effort and
-- STATELESS by contract: it fires on every call. There is no alert_state table
-- and no last_alerted_at column anywhere. The existing breakers avoid alert
-- storms only as a SIDE EFFECT OF LATCHING (send_paused flips true and stops
-- further trips), which is not a reusable mechanism.
--
-- Only a TRANSITION into 'firing' notifies; remaining 'firing' is silent. Kept
-- generic because the drip scheduler's dead-man alert (P5) needs the same thing.
--
-- Infra table, org-optional => RLS enabled with NO policies, the same posture as
-- cron_locks and geoip_cache. There is no legitimate client read to preserve.
--
-- ADDITIVE. Two new tables.

CREATE TABLE public.partner_key_usage (
  org_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  partner_key_id integer NOT NULL REFERENCES public.partner_keys(id) ON DELETE CASCADE,
  window_kind    text NOT NULL,
  window_start   timestamptz NOT NULL,
  count          integer NOT NULL DEFAULT 0,

  PRIMARY KEY (partner_key_id, window_kind, window_start),

  CONSTRAINT partner_key_usage_window_kind_check
    CHECK (window_kind IN ('sec', 'day', 'auth_fail')),
  CONSTRAINT partner_key_usage_count_check
    CHECK (count >= 0)
);
--> statement-breakpoint

-- The settings UI's "last 24h" panel, and the pruner's scan.
CREATE INDEX partner_key_usage_org_kind_window_idx
  ON public.partner_key_usage (org_id, window_kind, window_start DESC);
--> statement-breakpoint

ALTER TABLE public.partner_key_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "partner_key_usage_select_own_org"
  ON public.partner_key_usage FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE TABLE public.alert_state (
  -- e.g. 'intake:auth_fail:42'
  alert_key        text PRIMARY KEY,
  -- Nullable: some alerts are global rather than per-org.
  org_id           uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  state            text NOT NULL,
  since            timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz,

  CONSTRAINT alert_state_state_check CHECK (state IN ('ok', 'firing'))
);
--> statement-breakpoint

-- Infra table: RLS on, NO policies. An absent policy denies everything to
-- anon/authenticated; the server's DATABASE_URL connection bypasses RLS.
ALTER TABLE public.alert_state ENABLE ROW LEVEL SECURITY;
