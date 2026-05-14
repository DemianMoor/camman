-- Architectural shift: segment_groups (folders for segments) → contact_groups
-- (tags on contacts). Plus a new rule type that filters on group membership.
--
-- Part A: rename segment_groups → contact_groups (rows preserved verbatim).
-- Part B: create contact_contact_groups junction.
-- Part C: migrate data — every (segment, group) link becomes (contact, group)
--   links for every contact in that segment. UNION-style fan-out via DISTINCT.
-- Part D: drop the old segment_segment_groups junction.
-- Part E: extend segment_rules rule_type CHECK to include is_in_contact_group.
-- Part F: (no-op — rule_filtered_count was added in 0029.)
-- Part G: RLS for contact_contact_groups; rename existing segment_groups
--   policies to contact_groups.

-- ============================================================================
-- Part A — rename segment_groups → contact_groups
-- ============================================================================
ALTER TABLE public.segment_groups RENAME TO contact_groups;
--> statement-breakpoint
ALTER TABLE public.contact_groups RENAME COLUMN segment_group_id TO contact_group_id;
--> statement-breakpoint

-- Rename constraints / sequence / index for cleanliness so future reads of
-- catalog metadata match the new table name. (Postgres tracks FK targets
-- by OID, so renames don't break references.)
ALTER INDEX public.segment_groups_pkey RENAME TO contact_groups_pkey;
--> statement-breakpoint
ALTER SEQUENCE public.segment_groups_id_seq RENAME TO contact_groups_id_seq;
--> statement-breakpoint
ALTER TABLE public.contact_groups RENAME CONSTRAINT segment_groups_segment_group_id_unique TO contact_groups_contact_group_id_unique;
--> statement-breakpoint
ALTER TABLE public.contact_groups RENAME CONSTRAINT segment_groups_status_check TO contact_groups_status_check;
--> statement-breakpoint

-- Rename RLS policies to match the new table name.
ALTER POLICY "segment_groups_select_own_org" ON public.contact_groups RENAME TO "contact_groups_select_own_org";
--> statement-breakpoint
ALTER POLICY "segment_groups_insert_manager_or_higher" ON public.contact_groups RENAME TO "contact_groups_insert_manager_or_higher";
--> statement-breakpoint
ALTER POLICY "segment_groups_update_manager_or_higher" ON public.contact_groups RENAME TO "contact_groups_update_manager_or_higher";
--> statement-breakpoint

-- ============================================================================
-- Part B — new junction: contacts ↔ contact_groups
-- ============================================================================
CREATE TABLE public.contact_contact_groups (
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  contact_group_id integer NOT NULL REFERENCES public.contact_groups(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT contact_contact_groups_pkey PRIMARY KEY (contact_id, contact_group_id)
);
--> statement-breakpoint
CREATE INDEX contact_contact_groups_group_id_idx ON public.contact_contact_groups(contact_group_id);
--> statement-breakpoint
CREATE INDEX contact_contact_groups_org_id_idx ON public.contact_contact_groups(org_id);
--> statement-breakpoint

-- ============================================================================
-- Part C — data migration
-- For every segment_segment_groups link, fan out to every contact currently
-- in that segment. DISTINCT + ON CONFLICT keeps things idempotent and
-- collapses duplicates (a contact in multiple groups via overlapping
-- segments becomes one row per (contact, group) pair).
-- Run BEFORE the DROP in Part D so data isn't lost.
-- ============================================================================
INSERT INTO public.contact_contact_groups (contact_id, contact_group_id, org_id, created_at)
SELECT DISTINCT sc.contact_id, ssg.segment_group_id, sc.org_id, now()
FROM public.segment_contacts sc
JOIN public.segment_segment_groups ssg ON ssg.segment_id = sc.segment_id
ON CONFLICT (contact_id, contact_group_id) DO NOTHING;
--> statement-breakpoint

-- ============================================================================
-- Part D — drop the old junction (and its policies, dropped automatically)
-- ============================================================================
DROP TABLE public.segment_segment_groups;
--> statement-breakpoint

-- ============================================================================
-- Part E — extend segment_rules CHECK to include is_in_contact_group
-- ============================================================================
ALTER TABLE public.segment_rules DROP CONSTRAINT segment_rules_rule_type_check;
--> statement-breakpoint
ALTER TABLE public.segment_rules ADD CONSTRAINT segment_rules_rule_type_check CHECK (rule_type IN (
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
  'member_of_segment',
  'is_in_contact_group'
));
--> statement-breakpoint

-- ============================================================================
-- Part G — RLS for contact_contact_groups
-- (contact_groups policies were already renamed in Part A; segment_rules RLS
-- exists from 0030.)
-- Manage permission = operator+ to match the existing contact-upload
-- permission level, since applying groups happens via the upload pipeline.
-- ============================================================================
ALTER TABLE public.contact_contact_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "contact_contact_groups_select_own_org"
  ON public.contact_contact_groups
  FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

CREATE POLICY "contact_contact_groups_insert_operator_or_higher"
  ON public.contact_contact_groups
  FOR INSERT
  WITH CHECK (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = contact_contact_groups.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
--> statement-breakpoint

CREATE POLICY "contact_contact_groups_delete_operator_or_higher"
  ON public.contact_contact_groups
  FOR DELETE
  USING (
    org_id = public.current_org_id()
    AND EXISTS (
      SELECT 1
      FROM public.org_members om
      WHERE om.org_id = contact_contact_groups.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin', 'manager', 'operator')
    )
  );
