-- W2 Task 1: contact_org_stats rollup table.
--
-- Replaces the live GROUP BY + uncapped COUNT(*) queries that fire on every
-- contacts-page load and every dashboard load:
--   • /api/contacts/carrier-stats — full 752K seq scan, 631ms confirmed by EXPLAIN
--   • /api/contacts/base-stats    — 6 uncapped counts over contacts×2, opt_outs,
--     opt_ins, clickers
--
-- One row per org. Scalar counts (total, archived, opt_out, opt_in, clicker)
-- are incremented by the writers in real-time using atomic ON CONFLICT DO UPDATE
-- counter bumps. carrier_breakdown JSONB is refreshed by the 1-min
-- /api/cron/refresh-contact-stats cron (GROUP BY over contacts once a minute
-- instead of on every page load). Both paths are feature-flagged so the live
-- aggregate path is instantly restorable.
--
-- updated_at is set to NOW() on every write so the UI can show "as of X".

CREATE TABLE public.contact_org_stats (
  org_id          UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Scalar counts — maintained by writers in real-time.
  total_count     INTEGER NOT NULL DEFAULT 0,
  archived_count  INTEGER NOT NULL DEFAULT 0,
  opt_out_count   INTEGER NOT NULL DEFAULT 0,
  -- Per-reason breakdown: {opt_out, scrubbed, bounced, suppressed} (counts, NOT distinct contacts).
  opt_out_by_reason JSONB NOT NULL DEFAULT '{"opt_out":0,"scrubbed":0,"bounced":0,"suppressed":0}'::jsonb,
  opt_in_count    INTEGER NOT NULL DEFAULT 0,
  clicker_count   INTEGER NOT NULL DEFAULT 0,
  -- Carrier / line-type breakdown updated by the 1-min cron.
  -- Null until the first cron run. Each key in carrier_breakdown:
  --   by_line_type: {mobile, landline, voip, ...} → count
  --   by_carrier_norm: {<carrier_name>} → count
  --   by_messaging_status: {eligible, not_applicable} → count
  carrier_breakdown JSONB,
  -- When any column was last written (for the "as of" UI label).
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
