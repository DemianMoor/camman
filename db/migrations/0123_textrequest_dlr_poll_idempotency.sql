-- Text Request Phase 3b — make the messages-poll DLR capture idempotent.
--
-- The poll (lib/sends/textrequest-messages-poll.ts) re-reads a rolling window of
-- GET /dashboards/{id}/messages every tick, so the SAME message is returned
-- again and again while it stays inside the window. Without a uniqueness key the
-- backstop would insert one duplicate textrequest_dlr_events row per message per
-- tick.
--
-- Scoped to method = 'poll' ON PURPOSE: the webhook channel must stay
-- unconstrained, because Text Request legitimately POSTs several status
-- callbacks for one message as it transitions states, and migration 0122
-- deliberately left message_id unconstrained for that reason.
--
-- Keyed on (provider_id, message_id, status) rather than message_id alone so a
-- real state CHANGE observed by the poll (sent -> delivered) still lands as its
-- own row, while a re-read of a state we already captured is dropped. status is
-- part of the key, so the poll must never insert a NULL status (NULLs are
-- distinct in a unique index and would defeat the dedup) — captureTxrPollDlrEvent
-- documents that contract and the poll filters null-status rows out.
CREATE UNIQUE INDEX textrequest_dlr_events_poll_uniq
  ON public.textrequest_dlr_events (provider_id, message_id, status)
  WHERE method = 'poll';
