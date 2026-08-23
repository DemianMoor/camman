-- Migration 0162: org_settings drip flags (Drip Phase 4, ruling G9).
--
-- ⚠️ THREE FLAGS, THREE QUESTIONS, KEPT APART ON PURPOSE:
--
--   capability — is drip BUILT?        ENTITY_AVAILABILITY, compile-time. Not here.
--   posture    — is drip SWITCHED ON?  org_settings.drip_enabled (default FALSE)
--   latch      — did something TRIP?   org_settings.drip_paused
--
-- Merging posture into the latch makes a breaker trip and a human decision
-- indistinguishable — the lesson the provider-connections work already paid for
-- with supports_api_send / sends_enabled / send_paused. An operator who cannot
-- tell "I turned this off" from "something turned this off" cannot safely turn
-- it back on.
--
-- This mirrors the existing sends_enabled / sends_paused shape exactly, audit
-- columns included, so there is one pattern to learn rather than two.
--
-- ⚠️ DEFAULT FALSE IS LOAD-BEARING BEYOND THE OBVIOUS. Posture does not merely
-- gate the routing worker: it also gates whether the drip branch is EMITTED into
-- the in-use CTE in lib/audience-snapshot.ts and lib/segment-rules-eval.ts. With
-- posture off, those builders produce character-for-character the SQL they
-- produce today, so the regular-campaign activation plan is identical BY
-- CONSTRUCTION rather than by measurement — which is what R14 actually asks for.
-- An always-emitted empty UNION branch was measured at +13% plan cost
-- (9,959 -> 11,292) and was rejected for exactly that reason.
--
-- ADDITIVE with behaviour-preserving defaults. No backfill.

ALTER TABLE public.org_settings
  ADD COLUMN drip_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE public.org_settings
  ADD COLUMN drip_enabled_updated_by uuid;
--> statement-breakpoint

ALTER TABLE public.org_settings
  ADD COLUMN drip_enabled_updated_at timestamptz;
--> statement-breakpoint

ALTER TABLE public.org_settings
  ADD COLUMN drip_paused boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE public.org_settings
  ADD COLUMN drip_paused_reason text;
--> statement-breakpoint

ALTER TABLE public.org_settings
  ADD COLUMN drip_paused_at timestamptz;
--> statement-breakpoint

ALTER TABLE public.org_settings
  ADD COLUMN drip_paused_by uuid;
