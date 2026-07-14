-- Lookup Stats Panel — per-Contact-Group coverage/suppression rollup cache.
--
-- The panel's aggregate is a full-population scan (contact_contact_groups ⋈
-- contacts, ~1.2s at 750K+ contacts), too heavy to run on every /settings/lookup
-- view. This tiny table caches the computed stats blob per org so the panel reads
-- it instantly; it is refreshed on a TTL / manual "Refresh now" (manager+).
--
-- One row per org: `data` is the whole { summary, groups[] } blob written
-- ATOMICALLY in a single upsert, so a refresh can never leave a partial cache; a
-- failed recompute leaves the prior row intact (degrade to older data, never blank).
--
-- Reversible: additive, org-scoped, no behaviour change. Drop to remove.

CREATE TABLE IF NOT EXISTS public.lookup_group_stats_cache (
  org_id      uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  data        jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE public.lookup_group_stats_cache ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Defense-in-depth: own-org SELECT (the panel reads through a server route that
-- also checks org + role). Writes happen server-side on the privileged Drizzle
-- connection (bypasses RLS), so no write policy — matches lookup_batches (0097).
DROP POLICY IF EXISTS "lookup_group_stats_cache_select_own_org" ON public.lookup_group_stats_cache;
--> statement-breakpoint

CREATE POLICY "lookup_group_stats_cache_select_own_org"
  ON public.lookup_group_stats_cache FOR SELECT
  USING (org_id = public.current_org_id());
