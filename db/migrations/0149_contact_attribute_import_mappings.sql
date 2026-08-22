-- Migration 0149: contact_attribute_import_mappings (Drip Phase 1, item 1c).
--
-- Saved column -> field mappings for CSV uploads that carry contact attributes
-- (0147). Mirrors result_import_mappings (the campaign-results importer) in
-- shape and intent, MINUS two of its columns:
--
--   * no sms_provider_id -- result mappings are per PROVIDER because each
--     provider exports a different CSV. An attribute CSV comes from a partner
--     or an operator's spreadsheet; there is no provider dimension, and adding
--     a nullable one "just in case" would put a meaningless NULL on every row.
--   * no status_value_map -- that translates a provider's status vocabulary to
--     ours. Attributes have no status.
--
-- `mapping` shape: { "<csv column header>": "<contact_attributes field>" }.
-- Only the FIELD side is constrained, and in Zod rather than here: the column
-- side is whatever the partner's spreadsheet happens to be called, and a CHECK
-- over JSONB keys could not express that anyway.
--
-- created_by is nullable + ON DELETE SET NULL: a saved mapping must outlive the
-- person who made it. Removing a user must not delete the org's import config,
-- and it must not fail either.

CREATE TABLE public.contact_attribute_import_mappings (
  id          serial PRIMARY KEY,
  org_id      uuid NOT NULL,
  name        text NOT NULL,
  -- Exactly one default per org, enforced by a PARTIAL unique index below
  -- rather than by application code -- the same shape short_domains uses for
  -- its per-brand default (0140). Application-side "unset the others first"
  -- races; the index cannot.
  is_default  boolean NOT NULL DEFAULT false,
  mapping     jsonb NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contact_attribute_import_mappings_org_id_organizations_id_fk
    FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT contact_attribute_import_mappings_created_by_users_id_fk
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  -- A mapping with no entries would silently import nothing.
  CONSTRAINT contact_attribute_import_mappings_mapping_nonempty_check
    CHECK (jsonb_typeof(mapping) = 'object' AND mapping <> '{}'::jsonb)
);
--> statement-breakpoint

-- Name is the operator's handle for the mapping; duplicates inside one org make
-- the picker ambiguous.
CREATE UNIQUE INDEX contact_attribute_import_mappings_org_name_uniq
  ON public.contact_attribute_import_mappings (org_id, lower(name));
--> statement-breakpoint

-- At most ONE default per org.
CREATE UNIQUE INDEX contact_attribute_import_mappings_one_default_per_org
  ON public.contact_attribute_import_mappings (org_id)
  WHERE is_default;
--> statement-breakpoint

-- Tenant table (it has org_id): RLS on WITH an org-scoped SELECT policy and NO
-- write policies -- the 0085 / 0146 / 0147 shape. An absent write policy is a
-- denial, so anon/authenticated lose INSERT/UPDATE/DELETE/TRUNCATE; every write
-- goes through the server's privileged Drizzle connection, which bypasses RLS.
ALTER TABLE public.contact_attribute_import_mappings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "contact_attribute_import_mappings_select_own_org"
  ON public.contact_attribute_import_mappings FOR SELECT
  USING (org_id = public.current_org_id());
