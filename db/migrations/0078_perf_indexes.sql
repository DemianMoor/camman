-- Migration 0078: additive performance indexes. Purely additive — NO column,
-- constraint, data, or semantic change. Every index below backs an existing
-- hot query path; none alters which rows a query returns.
--
-- Index-build locking note: these are plain (non-CONCURRENT) CREATE INDEX
-- statements because drizzle-kit migrate runs each migration inside a
-- transaction (CONCURRENTLY cannot). Each takes a brief SHARE lock (blocks
-- writes, allows reads) on its table for the build duration. On the largest
-- table (contacts, targeting millions of rows at maturity) this can be a
-- noticeable write pause. If contacts is already large in the target
-- environment, build contacts_org_id_created_at_idx by hand with
-- CREATE INDEX CONCURRENTLY *before* applying this migration; the statement
-- here will then no-op-fail-safe only if you also add IF NOT EXISTS — otherwise
-- drop the contacts line from this file for that environment. At current data
-- volumes the inline build is fine.

-- opt_outs: the suppression EXISTS probes filter on (contact_id AND org_id)
-- together (lib/audience-snapshot.ts, lib/sends/recipients.ts). Only separate
-- single-column indexes existed; this composite lets the probe index-only match.
-- COMPLIANCE-CRITICAL table — additive index only, changes no suppression logic.
CREATE INDEX opt_outs_org_id_contact_id_idx ON public.opt_outs (org_id, contact_id);

-- stage_result_rows: the only large domain table with no org_id index at all.
-- Backs org-wide results/audit queries and the default created_at list ordering.
CREATE INDEX stage_result_rows_org_id_created_at_idx ON public.stage_result_rows (org_id, created_at);

-- contacts: at millions of rows the default list view sorts/paginates by
-- created_at within an org; without this it sorts the whole org partition.
CREATE INDEX contacts_org_id_created_at_idx ON public.contacts (org_id, created_at);

-- campaign_stages: the */15 scheduled-send cron scans for due-and-unfired stages
-- (scheduled_at <= now AND sent_at IS NULL AND schedule_missed_at IS NULL,
-- ORDER BY scheduled_at). Partial index on exactly that predicate keeps the scan
-- tiny as stage count grows. See lib/sends/scheduled.ts selectDueStages.
CREATE INDEX campaign_stages_scheduled_due_idx ON public.campaign_stages (scheduled_at)
  WHERE sent_at IS NULL AND schedule_missed_at IS NULL;

-- campaigns: "active campaigns for this org" is the dominant filter (audience
-- in-use exclusion, scheduler). A single low-cardinality status index is weak;
-- this composite serves org_id + status together.
CREATE INDEX campaigns_org_id_status_idx ON public.campaigns (org_id, status);

-- stage_sends: the /api/sends/state stuck-row count [count(*) WHERE org_id = X
-- AND status = 'sending'] runs on EVERY protected page (the send-state strip).
-- (org_id, sent_at) already exists for the 24h breaker accounting, but there was
-- no index for the status='sending' probe. Tiny partial index — 'sending' is a
-- transient state, so this stays near-empty. (Snapshot note: public.stage_sends
-- predates the current snapshot's table set, so this index lives in the SQL +
-- db/schema.ts only, like the table's other indexes.)
CREATE INDEX stage_sends_org_sending_idx ON public.stage_sends (org_id) WHERE status = 'sending';
