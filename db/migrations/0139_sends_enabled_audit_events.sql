-- Audit the per-provider `sends_enabled` posture switch (R4).
--
-- Migration 0138 added sms_providers.sends_enabled — the operator's deliberate
-- "should this account be sending right now". R4 puts a toggle on
-- /settings/providers, and docs/07-conventions.md ("Go-live gates never live on
-- a bulk settings form") requires such a flag to have its own endpoint, its own
-- Zod schema, and an audit row naming the actor. sms_providers has no
-- `updated_at` and nothing else records who changed a send posture, so without
-- this the toggle would be unattributable — exactly the hole that made the 2026-
-- 08-13 `supports_api_send` reversion undiagnosable (ClickUp 869ehjwtf).
--
-- Reusing send_circuit_events rather than adding a table, for the same reason
-- 0131 did: it is already the per-provider "who changed the send posture, when,
-- and why" log, keyed on the same provider, with the same actor column.
--
-- ⚠️ NEW VERBS, NOT the existing 'paused'/'resumed'. Those mean the LATCHING
-- circuit breaker tripped or a human cleared it. Posture is a different event
-- with a different remedy — nothing tripped and there is nothing to resume — and
-- reusing the breaker's verbs would make an automated trip and a human decision
-- indistinguishable when reading the history back, which is the one thing this
-- table exists to keep apart.
--
-- Additive: widens a CHECK, writes no rows, inert until the R4 endpoint ships.
-- Mirrors 0131 exactly. No lock concern — the constraint is on
-- send_circuit_events, an append-only audit table, not on a hot send path.
ALTER TABLE public.send_circuit_events
  DROP CONSTRAINT send_circuit_events_event_check;
--> statement-breakpoint
-- 'paused' / 'resumed'                      — the latching circuit breaker (0058)
-- 'api_send_enabled' / '..._disabled'       — the supports_api_send go-live gate (0131)
-- 'sends_enabled_on' / 'sends_enabled_off'  — the operator posture switch (0138/R4)
--
-- Three distinct pairs because they answer three distinct questions: did a
-- breaker trip, is this account allowed to API-send at all, and does the
-- operator want it sending right now.
ALTER TABLE public.send_circuit_events
  ADD CONSTRAINT send_circuit_events_event_check
  CHECK (event IN (
    'paused', 'resumed',
    'api_send_enabled', 'api_send_disabled',
    'sends_enabled_on', 'sends_enabled_off'
  ));
