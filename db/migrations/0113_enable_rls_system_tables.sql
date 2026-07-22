-- Migration 0113: close the Supabase security-advisor ERRORs on internal
-- system/report tables and one report view.
--
-- Context (see docs/07-conventions.md §RLS): the app NEVER reaches the database
-- through PostgREST / the Data API. All table access goes through Drizzle over
-- DATABASE_URL (the transaction pooler), which connects as a role that BYPASSES
-- RLS. The supabase-js client is used for Auth only — there are zero
-- `supabase.from('<table>')` data calls in the codebase. RLS is therefore
-- defense-in-depth against the public anon key hitting `/rest/v1/*`, not the
-- primary tenant isolation (that is application-level org_id filtering).
--
-- These five tables shipped in earlier migrations with RLS left DISABLED, so
-- they were reachable (read AND write) through the public Data API with the
-- anon key. Enabling RLS with NO policy denies all PostgREST access while the
-- app keeps working unchanged — exactly the state the 8 sibling system tables
-- (provider_credentials, lookup_queue, phone_lookups, geoip_cache, …) already
-- run in. No policy is added on purpose: nothing should reach these over the API.
--
-- Advisor lints resolved:
--   0013_rls_disabled_in_public   (5 tables, ERROR)
--   0010_security_definer_view    (offer_report_campaign_econ, ERROR)

-- 1. Enable RLS on the five internal tables (no policy ⇒ PostgREST sees nothing;
--    the direct Drizzle connection is unaffected).
ALTER TABLE public.cron_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_stage_hour ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_group_hour ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_refresh_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carrier_norm_backfill_snapshot ENABLE ROW LEVEL SECURITY;

-- 2. Make the report view run as SECURITY INVOKER so it enforces the querying
--    user's permissions/RLS rather than the (postgres) view creator's. The app
--    reads this view only through the direct connection, so invoker semantics
--    are transparent to CamMan and simply stop the anon/authenticated roles from
--    using it to bypass RLS via `/rest/v1/offer_report_campaign_econ`.
ALTER VIEW public.offer_report_campaign_econ SET (security_invoker = true);
