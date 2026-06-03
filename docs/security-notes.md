# Security notes & deferred hardening

Cross-cutting security decisions and conscious tradeoffs, with the hardening
items they imply. Add a line here whenever a v1 shortcut trades security for
speed so it isn't silently forgotten.

## Provider API credentials stored plaintext at rest (TextHub send pipeline)

**Decision (v1):** `provider_credentials.api_key` (the TextHub API key, one per
provider) is stored **plaintext** in Postgres.

**Why it's acceptable for now:**
- The table has **deny-by-default RLS** (RLS enabled, *no* policies) — the
  anon/auth Supabase clients cannot read or write it at all. Only the
  privileged server-side Drizzle connection (which bypasses RLS) touches it.
- All legitimate access goes through server code with app-layer permission
  checks; the key is **never sent to the browser** (management UI shows
  set/not-set only).

**Hardening to do later (not done in v1):**
- Encrypt the key at rest (e.g. pgcrypto / app-level envelope encryption) or
  move it to a dedicated secrets manager (Vault, Doppler, AWS Secrets Manager).
- Consider per-key rotation + last-used auditing.

**Where it lives:** `provider_credentials` table (migration 0050), schema
comment in [db/schema.ts](../db/schema.ts), SQL comment in
[db/migrations/0050_stage_sends.sql](../db/migrations/0050_stage_sends.sql).
