-- Segment rules: declarative filters that narrow a segment's audience
-- on top of its manual `segment_contacts` membership. Zero rules = no
-- filtering. Rules combine with AND. See lib/segment-rules-eval.ts and
-- lib/validators/segment-rule-types.ts for the type↔operator↔value spec.
--
-- No UNIQUE on (segment_id, position) — drag-reorders briefly produce
-- duplicate positions; the reorder endpoint renumbers atomically.

CREATE TABLE public.segment_rules (
  id serial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  segment_id integer NOT NULL REFERENCES public.segments(id) ON DELETE CASCADE,
  rule_type text NOT NULL,
  operator text NOT NULL,
  value jsonb,
  position integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT segment_rules_rule_type_check CHECK (rule_type IN (
    'is_clicker_any_brand',
    'is_clicker_for_brand',
    'is_clicker_for_offer',
    'is_optin_any_brand',
    'is_optin_for_brand',
    'is_optout_for_brand',
    'contact_added_in_last_n_days',
    'contact_added_more_than_n_days_ago',
    'joined_segment_in_last_n_days',
    'joined_segment_more_than_n_days_ago',
    'member_of_segment'
  )),
  CONSTRAINT segment_rules_operator_check CHECK (operator IN ('is', 'is_not'))
);
--> statement-breakpoint
CREATE INDEX segment_rules_segment_position_idx
  ON public.segment_rules (segment_id, position);
--> statement-breakpoint
CREATE INDEX segment_rules_org_id_idx
  ON public.segment_rules (org_id);
--> statement-breakpoint

-- segment_stats gets a new column: rule_filtered_count. Nullable because
-- it's only populated by /refresh-stats; pre-existing rows show "—" in
-- the UI until refreshed. total_count keeps its existing semantic (raw
-- manual membership count, maintained by the per-row trigger).
ALTER TABLE public.segment_stats
  ADD COLUMN rule_filtered_count integer;
