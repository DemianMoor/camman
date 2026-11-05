-- 0235: index every foreign key that references contacts(id).
--
-- Deleting a contact fires Postgres's FK trigger once per referencing table:
-- `DELETE FROM t WHERE contact_id = $1` (ON DELETE CASCADE) or
-- `UPDATE t SET col = NULL WHERE col = $1` (ON DELETE SET NULL). That filter is
-- on the FK column ALONE, so an index only helps if the column LEADS it — the
-- existing (org_id, …, contact_id) composites cannot serve it on PG 17 (no
-- btree skip scan). These 12 tables had no such index, so one contact delete
-- seq-scanned ~21M rows (stage_sends 7.9M, creative_exposures 7.4M,
-- offer_exposures 3.5M, …) and hit the 120 s statement_timeout: the contact
-- page's Delete failed with "canceling statement due to statement timeout"
-- (2026-11-05, DELETE /api/contacts/[id]). The cost grew linearly with the
-- tables; with the index it is a log-n probe per table regardless of size.
--
-- Nullable SET NULL columns get a partial index (… IS NOT NULL): the trigger's
-- `col = $1` implies it, and unmatched inbound rows stay out of the index.
--
-- ⚠️ ON PRODUCTION THESE ARE BUILT FIRST, CONCURRENTLY, by
-- scripts/apply-contact-fk-indexes-concurrent.ts --apply. These plain
-- CREATE INDEX IF NOT EXISTS then no-op and only record the migration. Run this
-- file alone against production first and it takes a SHARE lock on stage_sends
-- (3 GB heap) for the whole build, blocking every send.
--
-- Guard: scripts/test-contact-fk-index-guard.ts (check:guards) fails any
-- future .references(() => contacts.id) column without a leading index.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stage_sends_contact_id_idx ON public.stage_sends (contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS creative_exposures_contact_id_idx ON public.creative_exposures (contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS offer_exposures_contact_id_idx ON public.offer_exposures (contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS lead_events_contact_id_idx ON public.lead_events (contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS drip_journeys_contact_id_idx ON public.drip_journeys (contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS counted_clickers_contact_id_idx ON public.counted_clickers (contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stage_manual_recipients_contact_id_idx ON public.stage_manual_recipients (contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stage_result_rows_contact_id_idx ON public.stage_result_rows (contact_id) WHERE contact_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS texthub_inbound_events_matched_contact_id_idx ON public.texthub_inbound_events (matched_contact_id) WHERE matched_contact_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS textrequest_inbound_events_matched_contact_id_idx ON public.textrequest_inbound_events (matched_contact_id) WHERE matched_contact_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ahoi_inbound_events_matched_contact_id_idx ON public.ahoi_inbound_events (matched_contact_id) WHERE matched_contact_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tells_webhook_events_matched_contact_id_idx ON public.tells_webhook_events (matched_contact_id) WHERE matched_contact_id IS NOT NULL;
