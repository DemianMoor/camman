-- Migration 0155: widen two CHECK constraints for the Drip Phase 3 enrichment
-- worker. Additive in effect — every value that was legal stays legal.
--
-- ⚠️ BOTH OF THESE WOULD OTHERWISE REJECT CORRECT-LOOKING CODE AT RUNTIME, with
-- a 23514 that says nothing about which layer is wrong. Same class of trap as
-- the segment-rule CHECK in Phase 1 item 1c, where `phone_type`/`carrier`
-- shipped uncreatable because the type was registered everywhere except the DB.
--
-- 1. lead_inbox.status gains 'awaiting_lookup'.
--
--    The enrichment worker is a TWO-PASS design, and it has to be: the Telnyx
--    lookup worker is a synchronous POLL (lib/telnyx/worker.ts claims from
--    lookup_queue and calls Telnyx inline), not a callback. There is nothing to
--    receive, so a lead whose number is not already cached must park in a state
--    that is neither 'received' (the first pass would re-enqueue it forever) nor
--    'processed' (it has no contact yet). 'awaiting_lookup' IS that state, and
--    the backlog monitor counts it SEPARATELY — a lead stuck behind a failed
--    lookup must not hide inside a healthy-looking inbox.
--
-- 2. lookup_batches.trigger gains 'drip_intake'.
--
--    Drip reuses the EXISTING enqueueNormalized + lookup worker rather than
--    opening a second lookup path (ruled), and that helper writes a
--    lookup_batches row whose `trigger` is CHECK-constrained. Without this the
--    very first drip enqueue fails with 23514.
--
-- Reversible: re-narrowing is a DROP + ADD with the old lists, valid as long as
-- no row uses a new value.

ALTER TABLE public.lead_inbox DROP CONSTRAINT lead_inbox_status_check;
--> statement-breakpoint

ALTER TABLE public.lead_inbox ADD CONSTRAINT lead_inbox_status_check
  CHECK (status IN (
    'received',         -- captured, not yet normalized
    'awaiting_lookup',  -- normalized, waiting on Telnyx (pass 2 finalizes)
    'processed',        -- contact + attributes + event written
    'rejected',         -- unusable payload (no parseable phone)
    'landline',         -- terminal: counted, then the row is removed
    'duplicate'
  ));
--> statement-breakpoint

ALTER TABLE public.lookup_batches DROP CONSTRAINT lookup_batches_trigger_check;
--> statement-breakpoint

ALTER TABLE public.lookup_batches ADD CONSTRAINT lookup_batches_trigger_check
  CHECK (trigger IN ('upload', 'backfill', 'csv_update', 'drip_intake'));
