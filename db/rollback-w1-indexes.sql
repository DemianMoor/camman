-- W1 Task 2 rollback — exact CREATE defs for the eligible-partial / group indexes.
-- Recreate CONCURRENTLY (no ACCESS EXCLUSIVE lock on the hot tables). Run each
-- statement standalone (CONCURRENTLY cannot run inside a transaction).
--
-- DROPPED by migration 0113 (recreate these to roll back):

CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_org_eligible_idx
  ON public.contacts USING btree (org_id)
  WHERE (messaging_status = 'eligible'::text);

CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_org_created_eligible_idx
  ON public.contacts USING btree (org_id, created_at)
  WHERE (messaging_status = 'eligible'::text);

-- KEPT (listed for completeness — NOT dropped by 0113):

-- contact_contact_groups_group_contact_idx (in use — 4→6 scans over the audit window)
CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_contact_groups_group_contact_idx
  ON public.contact_contact_groups USING btree (contact_group_id, contact_id);

-- contacts_org_carrier_eligible_idx (new carrier-v2 partial — re-audit in W2 Task 1)
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_org_carrier_eligible_idx
  ON public.contacts USING btree (org_id, carrier_norm)
  WHERE (messaging_status = 'eligible'::text);

-- contacts_org_linetype_eligible_idx (new carrier-v2 partial — re-audit in W2 Task 1)
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_org_linetype_eligible_idx
  ON public.contacts USING btree (org_id, line_type)
  WHERE (messaging_status = 'eligible'::text);
