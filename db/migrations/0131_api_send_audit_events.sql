-- Audit the `supports_api_send` go-live gate (ClickUp 869ehjwtf).
--
-- Context: `sms_providers.supports_api_send` gates whether a provider can send
-- live SMS at all, but it was editable from the bulk provider form, which
-- submits the WHOLE object on every save with no concurrency check. A page
-- loaded while the flag was true and saved after it was set false wrote `true`
-- straight back — observed on the `tls` provider on 2026-08-13. It now moves to
-- a dedicated endpoint, exactly like `send_paused` (which was excluded from
-- that same form for the same reason — see lib/validators/providers.ts).
--
-- `send_paused` already had an audit trail; this flag had NONE, and
-- `sms_providers` has no `updated_at`, which is why the reversion could not be
-- attributed to an actor or a time. Reusing send_circuit_events rather than
-- adding a table: it is already the per-provider "who changed the send posture,
-- when, and why" log, keyed on the same provider, with the same actor column.
--
-- Additive: widens a CHECK, writes no rows, and is inert until the new endpoint
-- ships. Mirrors 0049, which widened the clicks classification CHECK the same
-- way. No lock concern — sms_providers is a tiny registry table, and the
-- constraint is on send_circuit_events, not on a hot path.
ALTER TABLE public.send_circuit_events
  DROP CONSTRAINT send_circuit_events_event_check;
--> statement-breakpoint
-- 'paused' / 'resumed'          — the latching send circuit breaker (0058).
-- 'api_send_enabled' / '..._disabled' — the supports_api_send go-live gate.
-- Both are "may this provider send right now" transitions, which is why they
-- share the table; they are distinct verbs so the two can never be confused
-- when reading the history back.
ALTER TABLE public.send_circuit_events
  ADD CONSTRAINT send_circuit_events_event_check
  CHECK (event IN ('paused', 'resumed', 'api_send_enabled', 'api_send_disabled'));
