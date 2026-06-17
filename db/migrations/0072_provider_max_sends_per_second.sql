-- Migration 0072: per-provider send rate limit (max_sends_per_second).
--
-- TextHub enforces a hard per-SECOND send rate that depends on the number type
-- (60/s short code, 3/s toll free). The existing circuit-breaker caps are
-- per-run / per-minute / per-24h — none of them bound the INSTANTANEOUS rate,
-- so the drain could burst past the provider's per-second ceiling and draw
-- rate-limit rejections. This column lets an operator set that ceiling per
-- provider in Settings; the drain paces its parallel sends to never exceed it
-- (resolveSendsPerSecond + the pacing loop in lib/sends/drain.ts).
--
-- Nullable: NULL => the built-in default (DEFAULT_SENDS_PER_SECOND). Non-
-- destructive, no backfill — every existing provider stays on the default until
-- a value is set.
ALTER TABLE public.sms_providers
  ADD COLUMN max_sends_per_second integer;
