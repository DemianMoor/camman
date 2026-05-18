-- ============================================================================
-- Tag every existing contact in the org with the "Weight Loss" contact group.
--
-- Run in the Supabase SQL editor (Project → SQL Editor → New query).
-- Idempotent — ON CONFLICT DO NOTHING means re-running is safe once every
-- contact already has the tag.
--
-- The script finds the group by NAME (case-sensitive) within whichever org
-- owns that group. If you have multiple orgs each with their own "Weight
-- Loss" group, every org's contacts will be tagged with their own group.
-- ============================================================================

-- Step 1 — Preview. Run this first and eyeball the numbers before Step 2.
SELECT
  o.id   AS org_id,
  o.name AS org_name,
  cg.id  AS contact_group_id,
  cg.name AS contact_group_name,
  (SELECT count(*)
     FROM public.contacts c
     WHERE c.org_id = o.id
       AND c.is_archived = false) AS active_contacts,
  (SELECT count(*)
     FROM public.contact_contact_groups ccg
     WHERE ccg.contact_group_id = cg.id) AS already_tagged
FROM public.organizations o
JOIN public.contact_groups cg
  ON cg.org_id = o.id
WHERE cg.name = 'Weight Loss';

-- Expected: 1 row per org that has a 'Weight Loss' group. `active_contacts`
-- minus `already_tagged` is roughly the number of rows the next statement
-- will insert (exact figure depends on whether some active contacts were
-- archived after the previous tagging run).
--
-- If Step 1 returns zero rows: the 'Weight Loss' group doesn't exist yet —
-- create it in the UI (or via the API) before continuing.

-- Step 2 — The actual insert.
WITH target_group AS (
  SELECT id, org_id
  FROM public.contact_groups
  WHERE name = 'Weight Loss'
)
INSERT INTO public.contact_contact_groups (contact_id, contact_group_id, org_id)
SELECT c.id, g.id, c.org_id
FROM public.contacts c
JOIN target_group g ON g.org_id = c.org_id
WHERE c.is_archived = false
ON CONFLICT (contact_id, contact_group_id) DO NOTHING;

-- The result panel will show how many rows were inserted. Re-running yields
-- "INSERT 0 0" once every contact is already tagged.
