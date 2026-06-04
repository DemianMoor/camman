-- Idempotency for polled inbound opt-outs (Stage B).
--
-- The opt-out intake polls TextHub's `?inbox=true` on a schedule. The inbox can
-- return the same message across repeated polls, so we dedupe on TextHub's
-- message id: each inbound message is recorded once in texthub_inbound_events
-- and a STOP is therefore acted on (suppressed) at most once.
--
-- Partial (provider_message_id IS NOT NULL) so Stage-A webhook rows that haven't
-- been parsed yet (NULL message id) don't collide. Scoped by provider_id, which
-- is per-org, so the key is org-safe even though TextHub message ids are global.
CREATE UNIQUE INDEX texthub_inbound_events_provider_msg_uniq
  ON public.texthub_inbound_events (provider_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
