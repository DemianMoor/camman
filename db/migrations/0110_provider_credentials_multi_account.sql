-- 0110_provider_credentials_multi_account.sql
-- Multi-account credentials + encryption-at-rest groundwork (Phase 1, additive).
-- Backward-compatible: existing plaintext rows keep working via dual-read.

-- 1. New columns (all nullable in Phase 1; tightened in 0111 after backfill).
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT;
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS api_key_last4 TEXT;
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS label TEXT;

-- 2. Allow encrypted-only writes: plaintext api_key no longer required.
--    The DB column becomes nullable now; the Drizzle type in db/schema.ts stays
--    non-null until the write-path task actually inserts NULL (nothing does yet).
ALTER TABLE provider_credentials ALTER COLUMN api_key DROP NOT NULL;

-- 3. Number -> account link.
ALTER TABLE provider_phones ADD COLUMN IF NOT EXISTS credential_id INTEGER
  REFERENCES provider_credentials(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS provider_phones_credential_id_idx ON provider_phones (credential_id);

-- 4. Allow N accounts per provider: drop the single-account uniques.
DROP INDEX IF EXISTS provider_credentials_provider_brand_uniq;
DROP INDEX IF EXISTS provider_credentials_provider_default_uniq;
