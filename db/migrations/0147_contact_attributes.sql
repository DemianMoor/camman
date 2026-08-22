-- Migration 0147: contact_attributes (Drip Campaigns Phase 1, item 1c).
--
-- 1:1 with contacts. Everything we know about a PERSON that is not their phone
-- number: name, address, demographics, and the drip provenance fields
-- (interest_tag, partner_slug). `contacts` carries no such column today — it is
-- phone + Telnyx enrichment + status only — so this adds a whole dimension
-- WITHOUT touching that hot table (815,426 rows / 386 MB as of 2026-08-22).
-- No column is added to `contacts`, and there is NO BACKFILL: this table starts
-- empty and is populated only by drip intake and mapped CSV uploads.
--
-- PHONE IS THE IDENTITY; everything here is an attribute. `email` therefore has
-- NO unique constraint: partners legitimately submit shared addresses, and a
-- unique index would make an import FAIL on a duplicate instead of updating it.
--
-- ⚠️ AGE IS NEVER STORED. `dob` is the only temporal fact. Age and age-band are
-- derived at query time from a dob RANGE, never with a per-row age():
--
--     ✗ EXTRACT(YEAR FROM age(dob)) BETWEEN 25 AND 34
--         a function of dob and now() evaluated per row — not sargable, so
--         contact_attributes_org_dob_idx can never be used.
--
--     ✓ dob >  (<ET today> - INTERVAL '35 years')
--       AND dob <= (<ET today> - INTERVAL '25 years')
--         a plain range; the index applies.
--
-- Same reasoning as the per-carrier daily cap (migration 0143), which passes an
-- ET day as a timestamptz RANGE rather than applying a function to sent_at,
-- precisely so its partial index survives. Band boundaries use the ET calendar
-- date — the same convention as the rest of the send path — not UTC.
--
-- ⚠️ UNDER-18 IS SCOPED TO THE age_band RULE, NOT GLOBAL. Inside that rule a
-- NULL dob matches nothing (you cannot demonstrate the band) and a hard
-- `dob <= <ET today> - INTERVAL '18 years'` floor applies independently of which
-- band was selected. A GLOBAL "never message a minor" gate is deliberately NOT
-- built here: measured 2026-08-22 there are 815,426 contacts and ZERO with a
-- dob, so a global "unknown dob = minor" predicate would exclude 100% of the
-- audience and take every campaign to zero recipients. When such a gate is
-- wanted its form is "exclude where dob is KNOWN and under 18" — never
-- "unknown = minor".

CREATE TABLE public.contact_attributes (
  -- The 1:1 is STRUCTURAL: contact_id IS the primary key. No surrogate id, so a
  -- second attribute row for one contact is impossible by construction.
  contact_id   uuid PRIMARY KEY,
  -- Carried even though it is reachable through contacts: every RLS policy and
  -- the hot segment-eval path filter on it directly, and joining through
  -- contacts purely to satisfy the policy would put a join in that path.
  org_id       uuid NOT NULL,

  first_name   text,
  last_name    text,
  address      text,
  state        text,
  country      text,
  -- Normalized (lowercase, trimmed) at the write boundary. No unique constraint.
  email        text,
  gender       text,
  -- Coded, not display text, so labels can be reworded without a data migration.
  income_band  text,
  kids         boolean,
  married      boolean,
  -- ⚠️ 1970-01-01 (epoch-as-blank) is normalized to NULL at intake and in the CSV
  -- mapping. The CHECK below CANNOT catch it — 1970-01-01 is a legitimate
  -- birthdate — so the write boundary is the only thing that closes it. Storing
  -- it would silently manufacture a 56-year-old cohort out of blank fields.
  dob          date,
  -- Deliberately NOT CHECK-constrained: interest tags are explicitly extensible
  -- (ACA / Medicare / Home_Services are only the initial set) and partner slugs
  -- are created per partner in Phase 2. Validated in Zod at the write boundary
  -- so adding one is a config change, not a migration.
  interest_tag text,
  partner_slug text,
  -- Which pipeline wrote this row: 'drip_intake', 'csv_upload', ...
  source       text,

  -- Fields not yet defined. No GIN index until a query actually needs one.
  extra        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- No created_at: contacts.created_at already answers "when did we first see
  -- this person", and a second, subtly different creation timestamp invites the
  -- two to be confused in reporting.
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contact_attributes_contact_id_contacts_id_fk
    FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE,
  CONSTRAINT contact_attributes_org_id_organizations_id_fk
    FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Closed sets that drive segment rules. Unconstrained, an import could write
  -- "50-75k" and silently match no rule at all.
  CONSTRAINT contact_attributes_income_band_check
    CHECK (income_band IS NULL OR income_band IN
      ('lt_25k','25k_50k','50k_75k','75k_100k','100k_150k','gte_150k')),
  CONSTRAINT contact_attributes_gender_check
    CHECK (gender IS NULL OR gender IN ('male','female','other')),
  -- Floor against import garbage (year 0001) and future dates. Does NOT and
  -- cannot exclude 1970-01-01 — see the dob comment above.
  CONSTRAINT contact_attributes_dob_sane_check
    CHECK (dob IS NULL OR (dob > DATE '1900-01-01' AND dob <= CURRENT_DATE))
);
--> statement-breakpoint

-- Five indexes, and the OMISSIONS are deliberate.
CREATE INDEX contact_attributes_org_idx
  ON public.contact_attributes (org_id);
--> statement-breakpoint
-- The two dimensions Drip routes on: interest_tag is the REQUIRED drip audience
-- field, partner_slug the optional filter. Hot by design.
CREATE INDEX contact_attributes_org_interest_idx
  ON public.contact_attributes (org_id, interest_tag);
--> statement-breakpoint
CREATE INDEX contact_attributes_org_partner_idx
  ON public.contact_attributes (org_id, partner_slug);
--> statement-breakpoint
-- Highest-cardinality optional filter.
CREATE INDEX contact_attributes_org_state_idx
  ON public.contact_attributes (org_id, state);
--> statement-breakpoint
-- Load-bearing for age bands: the band predicate is a RANGE on dob, which this
-- serves. It would be useless if age were computed per row.
CREATE INDEX contact_attributes_org_dob_idx
  ON public.contact_attributes (org_id, dob);
--> statement-breakpoint

-- NOTE: no index on gender / kids / married / country / income_band. Two to six
-- distinct values over what will become hundreds of thousands of rows means
-- Postgres seq-scans regardless, and a btree there taxes the intake write path
-- for nothing. They are used in COMBINATION with a selective rule, and the
-- segment evaluator INTERSECTs per-branch sets, so the selective branch drives
-- the plan. Add one only when a measurement asks for it — on the creatives list
-- an index measured WORSE than none.

-- RLS: tenant table (it has org_id), so it gets an org-scoped SELECT policy and
-- NO write policies — the 0085 / 0146 shape. An absent write policy is a denial,
-- so anon/authenticated lose INSERT/UPDATE/DELETE/TRUNCATE entirely. Every
-- writer is the server's privileged Drizzle connection (DATABASE_URL), which
-- authenticates as the database role and BYPASSES RLS, as does service_role.
ALTER TABLE public.contact_attributes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "contact_attributes_select_own_org"
  ON public.contact_attributes FOR SELECT
  USING (org_id = public.current_org_id());
