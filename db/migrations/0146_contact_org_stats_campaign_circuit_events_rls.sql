-- Migration 0146: enable RLS on contact_org_stats (0145) and
-- campaign_circuit_events (0119).
--
-- Supabase advisor: rls_disabled_in_public — TWO ERROR-level lints, red on
-- clean main before this migration. Both tables shipped without
-- `ENABLE ROW LEVEL SECURITY`, which is the same oversight migration 0113
-- closed for five other tables. This is the third such remediation after
-- 0066 (geoip_cache) and 0085 (stage_manual_sales + opt_out_attributions).
--
-- ⚠️ NOT a theoretical lint. Confirmed against production before writing this:
-- BOTH `anon` and `authenticated` hold
--   SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
-- on both tables (information_schema.role_table_grants), and with RLS off
-- nothing constrains them. The anon key ships in the frontend bundle, so this
-- was reachable over PostgREST by anyone who loaded the app.
--
--   * campaign_circuit_events is the more serious of the two. It is the
--     append-only AUDIT TRAIL of every per-campaign send pause/resume, and its
--     `reason` strings embed opt-out rates and stage ids
--     (e.g. "optout_rate_spike: 12.4% (62/500) on stage 1713 over 24h").
--     Nothing recomputes it, so a tampered or deleted row is gone for good.
--   * contact_org_stats leaks org-wide contact counts and the full carrier
--     breakdown. Writes to it self-heal within <=60s, because
--     refreshContactOrgStats (lib/contact-stats.ts, driven by the 1-minute
--     /api/cron/refresh-contact-stats cron) is a FULL recompute with
--     ON CONFLICT (org_id) DO UPDATE SET ... = EXCLUDED... — but the read is a
--     leak regardless.
--
-- BOTH tables carry org_id, so per docs/07-conventions.md they are TENANT
-- tables: RLS enabled WITH an org-scoped SELECT policy — never policy-less.
-- (Policy-less is correct only for org-less infra tables such as geoip_cache
-- and cron_locks, where there is no legitimate client read to preserve.)
--
-- This mirrors 0085 exactly, which in turn mirrors the stage_sends precedent
-- (0050). The template is already live on the DIRECT SIBLING of one of these
-- tables: send_circuit_events — the provider-level twin of
-- campaign_circuit_events — has carried
--   send_circuit_events_select_own_org | SELECT | (org_id = current_org_id())
-- since 0085. Migration 0119 simply missed the campaign-level twin when it
-- created it, as 0145 did for contact_org_stats.
--
-- SELECT-only, NO write policies. An absent policy is a denial, which is
-- exactly what we want: anon/authenticated lose INSERT/UPDATE/DELETE/TRUNCATE
-- entirely. Every writer of both tables is the server's privileged
-- Drizzle/postgres-js connection (DATABASE_URL), which authenticates as the
-- database role and BYPASSES RLS — as does service_role:
--   * contact_org_stats       — read by app/api/contacts/base-stats/route.ts and
--     app/api/contacts/carrier-stats/route.ts; written by lib/contact-stats.ts
--     (writer counter bumps + the 1-min cron recompute).
--   * campaign_circuit_events — written by lib/sends/circuit-breakers.ts
--     (latchCampaignPause) and
--     app/api/campaigns/[campaignId]/send-circuit/route.ts.
-- There is NO client-side table access anywhere in the app: lib/supabase/ is
-- used for auth only, and no component or route queries a table through the
-- Supabase JS client. So no policy added here can break a browser read —
-- there are none to break.
--
-- current_org_id() is the same auth-claim helper every tenant table uses
-- (0001_security_layer.sql):
--   SELECT org_id FROM public.org_members WHERE user_id = auth.uid() LIMIT 1
-- For `anon`, auth.uid() is NULL, so the function returns NULL and
-- `org_id = NULL` evaluates to NULL rather than true — every row is denied.
-- An authenticated user sees only their own org's rows.
--
-- Additive and fully reversible: no data change, no column change, no table
-- rewrite. Rollback is DROP POLICY + ALTER TABLE ... DISABLE ROW LEVEL SECURITY.

ALTER TABLE public.contact_org_stats ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.campaign_circuit_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "contact_org_stats_select_own_org"
  ON public.contact_org_stats FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "campaign_circuit_events_select_own_org"
  ON public.campaign_circuit_events FOR SELECT
  USING (org_id = public.current_org_id());
