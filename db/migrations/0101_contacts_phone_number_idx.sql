-- Telnyx Number Lookup — phase 3: btree index on contacts.phone_number.
--
-- The global phone_lookups cache is keyed on phone; contact sync (and the CSV
-- upload/bulk-update paths) match contacts by phone_number ACROSS orgs. The only
-- existing index is unique(org_id, phone_number), which cannot serve a bare
-- `phone_number = x` / `phone_number = ANY(...)` equality (org_id is the leading
-- column); the trigram GIN serves LIKE, not equality. Without this, cross-org sync
-- seq-scans the whole contacts table per phone.
--
-- Non-partial (sync must reach landline rows too). Built CONCURRENTLY in prod via
-- scripts/apply-eligible-indexes-concurrent.ts-style apply; the IF NOT EXISTS
-- statement below then no-ops.
CREATE INDEX IF NOT EXISTS contacts_phone_number_idx
  ON public.contacts (phone_number);
