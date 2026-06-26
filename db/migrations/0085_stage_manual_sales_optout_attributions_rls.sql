-- Enable RLS on stage_manual_sales (0079) and opt_out_attributions (0075).
-- Supabase advisor: rls_disabled_in_public — with RLS off, the anon/auth
-- PostgREST roles can read/write every row; stage_manual_sales directly moves
-- reported revenue. Second RLS remediation after geoip_cache (0066).
--
-- Unlike geoip_cache (infra cache, no org_id → enabled policy-less), BOTH of
-- these are tenant tables with an org_id, so we enable RLS WITH org-scoped
-- policies — never policy-less (which would block all access).
--
-- Both tables are written EXCLUSIVELY by the server's privileged Drizzle/
-- postgres-js connection, which authenticates as the database role and BYPASSES
-- RLS (as does service_role):
--   * stage_manual_sales  — manual-results route (app/api/campaigns/[campaignId]/
--     stages/[stageId]/manual-results/route.ts) and migration backfills.
--   * opt_out_attributions — lib/sends/poll-opt-outs.ts and backfill scripts.
-- No anon/SSR/browser Supabase client ever inserts or updates either table.
-- They are READ org-scoped (the Reports tab via Drizzle), so we mirror the
-- stage_sends precedent (0050): an org-scoped SELECT policy and NO write
-- policies. current_org_id() is the same auth-claim helper every tenant table
-- uses (0001_security_layer.sql).

ALTER TABLE public.stage_manual_sales ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.opt_out_attributions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "stage_manual_sales_select_own_org"
  ON public.stage_manual_sales FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "opt_out_attributions_select_own_org"
  ON public.opt_out_attributions FOR SELECT
  USING (org_id = public.current_org_id());
