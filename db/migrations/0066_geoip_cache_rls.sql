-- Enable RLS on geoip_cache (Supabase advisor: rls_disabled_in_public).
--
-- geoip_cache (migration 0054) is INFRA cache, NOT tenant data — it holds the
-- global MaxMind GeoLite2 .mmdb blob and has no org_id. It is read/written
-- exclusively server-side via the Drizzle/postgres-js direct connection in
-- lib/links/geoip-cache.ts (reached only from the server-only geoip.ts click
-- scorer). That connection authenticates as the database role, which BYPASSES
-- RLS — as does service_role. No Supabase anon/SSR/browser client ever touches
-- this table.
--
-- Therefore we enable RLS with NO policies: this closes the anon/authenticated
-- PostgREST door the advisor flagged (default-deny for non-bypass roles) while
-- leaving all server code working unchanged. A scoped policy would be pointless
-- here — there is no org_id to scope by and no legitimate client-side caller.

ALTER TABLE public.geoip_cache ENABLE ROW LEVEL SECURITY;
