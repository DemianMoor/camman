# Security notes & deferred hardening

Cross-cutting security decisions and conscious tradeoffs, with the hardening
items they imply. Add a line here whenever a v1 shortcut trades security for
speed so it isn't silently forgotten.

## Provider API credentials — encrypted at rest (multi-account, migration 0110)

**Decision (as of migration 0110, applied 2026-07-16):** `provider_credentials`
now stores the TextHub/Ahoi API key as an AES-256-GCM ciphertext
(`api_key_encrypted`, via [lib/crypto/secret-box.ts](../lib/crypto/secret-box.ts)),
not plaintext. This supersedes the original v1 "plaintext by design" decision
below — encryption was the hardening item that decision explicitly deferred.

**Scheme:**
- AES-256-GCM, 12-byte random IV per encryption. Blob format:
  `v1.<base64url(iv)>.<base64url(ciphertext)>.<base64url(authTag)>`.
- Master key: env `PROVIDER_CREDENTIALS_KEY`, a 32-byte base64 value. Never
  committed; must be byte-identical between Vercel and every local
  `.env.local` that encrypts (the backfill script) or decrypts (dev
  drain/pollers) — see [08-local-setup.md](08-local-setup.md).
- The leading `v1.` version segment is a rotation seam: a future master-key
  rotation ships new writes as `v2.` alongside still-decryptable `v1.` blobs
  (`decryptSecret` dispatches on the prefix), so rotation doesn't require a
  big-bang re-encrypt of every row.
- `provider_credentials.api_key` (plaintext) is **still present and
  nullable** — kept only for a **dual-read window**
  (`decryptCredentialKey` in [lib/sends/provider-credential.ts](../lib/sends/provider-credential.ts)
  prefers `api_key_encrypted`, falls back to legacy plaintext `api_key`). It
  is dropped in a later, separately-gated migration `0112` once every row has
  been backfilled and a stability window has passed (`0111` first tightens
  the new columns to `NOT NULL`); neither is applied yet.
- The plaintext key is never sent to the browser — every list/GET response
  shows `label`/`last4`/`masked` only. Decryption happens in exactly five
  places: the send drain, the opt-out/DLR pollers, and the credential
  test-send / register-callback actions — never in a list or response path.
  See [04-features/sms-send-pipeline.md](04-features/sms-send-pipeline.md)
  and [07-conventions.md](07-conventions.md).

**Unchanged — still the primary defenses, encryption is defense-in-depth on top:**
- `provider_credentials` still has **deny-by-default RLS** (RLS enabled, *no*
  policies) — the anon/auth Supabase clients cannot read or write it at all.
  Only the privileged server-side Drizzle connection (which bypasses RLS)
  touches it.
- All legitimate access goes through server code with app-layer permission
  checks: `provider_credentials.view` (manager+) gates the masked list;
  `provider_credentials.manage` (admin+) gates every mutation (create,
  rotate, edit, delete, test-send, register-callback).

**Hardening still open:**
- Migration `0111` (NOT NULL the new columns + encrypted-only reads) and
  `0112` (drop the plaintext `api_key` column, retiring the legacy
  `resolveProviderApiKey` helper and `scripts/probe-texthub-status.ts`'s use
  of it) are **planned, not yet drafted** — each is its own explicit prod
  gate, run only after a stability window on the prior step.
- No per-key rotation schedule or last-used auditing yet (the `v1.` prefix
  makes a future master-key rotation *possible*, not automatic).

**Where it lives:** `provider_credentials` table (migration 0050, extended by
migration 0110); [lib/crypto/secret-box.ts](../lib/crypto/secret-box.ts)
(encrypt/decrypt); [lib/sends/provider-credential.ts](../lib/sends/provider-credential.ts)
(resolution + dual-read); [scripts/backfill-provider-credentials-encryption.ts](../scripts/backfill-provider-credentials-encryption.ts)
(one-time backfill, applied 2026-07-16).
