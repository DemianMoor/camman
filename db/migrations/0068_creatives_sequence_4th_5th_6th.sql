-- Widen creatives.sequence_placement to support up to 6 messages in a
-- sequence: add '4th', '5th', '6th' as valid values. No data backfill needed
-- (existing rows keep their current placement; default stays 'unknown').

ALTER TABLE public.creatives
  DROP CONSTRAINT "creatives_sequence_placement_check";
--> statement-breakpoint

ALTER TABLE public.creatives
  ADD CONSTRAINT "creatives_sequence_placement_check"
  CHECK (sequence_placement IN ('warmup', '1st', '2nd', '3rd', '4th', '5th', '6th', 'any', 'unknown'));
