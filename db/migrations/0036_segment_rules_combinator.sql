-- Per-rule combinator for segment rules. Each rule (except the first)
-- joins to the running AND/OR of the prior rules via this combinator.
-- The first rule's combinator is read but ignored at eval time.
--
-- Default is 'and' so existing data preserves current behavior — every
-- pre-existing rule remains AND-joined and the audience for existing
-- segments doesn't change on deploy.

ALTER TABLE public.segment_rules
  ADD COLUMN combinator text NOT NULL DEFAULT 'and';
--> statement-breakpoint
ALTER TABLE public.segment_rules
  ADD CONSTRAINT segment_rules_combinator_check
  CHECK (combinator IN ('and', 'or'));
