-- Add 'warmup' as a valid creatives.sequence_placement value.
-- Widen the CHECK constraint; no data backfill needed (existing rows keep
-- their current placement, default stays 'unknown').

ALTER TABLE public.creatives
  DROP CONSTRAINT "creatives_sequence_placement_check";
--> statement-breakpoint

ALTER TABLE public.creatives
  ADD CONSTRAINT "creatives_sequence_placement_check"
  CHECK (sequence_placement IN ('warmup', '1st', '2nd', '3rd', 'any', 'unknown'));
