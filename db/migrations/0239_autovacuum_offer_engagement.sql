-- 0239: per-table autovacuum thresholds for contact_offer_campaigns and
-- contact_engagement.
--
-- WHY (measured on production 2026-11-12, read-only):
--   contact_offer_campaigns  4.09M live, 703K dead, last autovacuum 10-26,
--                            56.7% of heap pages all-visible
--   contact_engagement       1.94M live, 357K dead, last autovacuum 11-10,
--                             5.5% of heap pages all-visible
-- At the defaults (autovacuum_vacuum_scale_factor 0.2, insert scale factor 0.2)
-- neither table reaches its trigger point for weeks: ~818K dead/inserted rows
-- for contact_offer_campaigns, ~388K for contact_engagement. Meanwhile the
-- visibility map decays, so index-only scans fall back to heap reads.
--
-- The campaign audience preview reads both: the offer cooldown/limit scan over
-- contact_offer_campaigns made 183,777 heap fetches for one offer and spent
-- 12.0 s of a ~25 s statement waiting on disk; the "texted in the last N days"
-- rule reads ~97K scattered contact_engagement rows (14 s). With the disk at its
-- IOPS ceiling in busy minutes, both push the preview past its 30 s limit.
--
-- 0.02 ⇒ a vacuum roughly every ~82K (offer) / ~39K (engagement) dead or
-- inserted rows. The insert scale factor matters as much as the dead-row one:
-- an insert-triggered vacuum is what sets visibility-map bits on freshly
-- appended pages. Analyze follows at the same rate so planner stats keep pace.
--
-- Behaviour: none. Storage parameters only change WHEN autovacuum visits these
-- tables; no row, count, or query result changes.
--
-- Lock: ALTER TABLE … SET (storage parameters) takes SHARE UPDATE EXCLUSIVE,
-- which blocks no SELECT/INSERT/UPDATE/DELETE. It does conflict with a running
-- (auto)vacuum on the same table, so lock_timeout makes the batch fail fast
-- instead of queueing — retry at a quieter moment rather than raising it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.contact_offer_campaigns SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);
--> statement-breakpoint
ALTER TABLE public.contact_engagement SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);
