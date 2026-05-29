-- Add a fourth opt_outs reason: 'suppressed' (Global Suppression).
--
-- Like 'scrubbed' and 'bounced', a 'suppressed' row is a UNIVERSAL exclusion
-- (no opt_out_brands junction) — it excludes the contact from every FUTURE
-- audience snapshot org-wide. It surfaces as a distinct contact status so the
-- operator can tell a globally-suppressed number apart from a brand-level
-- STOP (reason='opt_out') or a non-mobile scrub (reason='scrubbed').
--
-- Frozen campaign_audience_pool rows are never recomputed, so existing
-- campaigns' committed audiences are unaffected by suppressing a number.

ALTER TABLE public.opt_outs
  DROP CONSTRAINT opt_outs_reason_check;
--> statement-breakpoint

ALTER TABLE public.opt_outs
  ADD CONSTRAINT opt_outs_reason_check
  CHECK (reason IN ('opt_out', 'scrubbed', 'bounced', 'suppressed'));
