# Design: Multi-Account Provider Credentials + Encryption at Rest + Admin UI

**Status:** Draft for review — spec only, no plan, no code.
**Date:** 2026-07-15
**Scope:** A future workstream, independent of the Ahoi phase. This document settles the four design questions and stops for review before any implementation plan.

---

## 0. Two premise corrections (read first)

While exploring the code I found two of the stated premises don't match what's actually in the repo. Flagging them up front because they change the shape of the work — neither is a blocker, but the design is built on the corrected facts, not the original framing.

**Correction 1 — Keys are already in the database, not env-only.**
Provider API keys live in `provider_credentials.api_key` (plaintext) and are read from there at send time by `resolveProviderApiKey()` ([lib/sends/provider-credential.ts](../../../lib/sends/provider-credential.ts)), and by the opt-out poller and Ahoi CDR poll. The env vars are narrower than "the keys":
- `AHOI_API_TOKEN` is used only by **recon/seed scripts**, which write the key into a DB row. The running app never reads it.
- `AHOI_API_BASE_URL` is a **non-secret base URL**, still read at send time — not a credential.

So this is **not** an env→DB migration. The real gaps are: (a) keys are stored **plaintext**, (b) there's **no UI** to enter/rotate them without a seed script, and (c) the schema allows only **one key per (provider, brand)**. This workstream closes those three.

**Correction 2 — There is no `BRAND_KEY_SECRET` / AES-256-GCM pattern to reuse.**
A full-repo search for `BRAND_KEY_SECRET`, `aes-256-gcm`, `createCipher*`, `encrypt`, `decrypt` returns **zero matches**. No encryption-at-rest exists anywhere today (the plaintext storage is a documented v1 tradeoff — see the comment on `provider_credentials` in [db/schema.ts](../../../db/schema.ts) and `docs/security-notes.md`). So the encryption module is **new work, built from scratch**, and it needs a **new env var** as its master key. I recommend a clearly-scoped name (`PROVIDER_CREDENTIALS_KEY`) rather than `BRAND_KEY_SECRET`, which would imply a brand-scoping it doesn't have.

**Correction 3 (minor, helps scope) — Credential management already exists.**
`ProviderCredentialsSection` ([components/providers/provider-credentials-section.tsx](../../../components/providers/provider-credentials-section.tsx)) plus `/api/providers/[providerId]/credentials/*` (list/create, get/update/delete, `test`, `register-callback`) already ship in `main`. The Admin UI question is therefore **extend existing credential management**, not build it fresh. Today it's just capped at one credential per (provider, brand) by a unique index.

---

## 1. Goals

1. **Multiple accounts per provider** — one provider (e.g. TextHub) can hold N independent accounts, each with its own API key and its own sending number(s).
2. **Key + number + account travel together** — a stage can never send from account A's number using account B's key. The coupling is structural, not a validation afterthought.
3. **Encryption at rest** — keys stored as AES-256-GCM ciphertext, decrypted only at send time. UI shows `••••last4` and never receives the plaintext.
4. **Admin UI to enter / edit / rotate** keys per account, with no seed script in the loop.
5. **No-downtime migration** of the existing plaintext keys (TextHub, Ahoi) into the new encrypted, multi-account shape.

## Non-goals (YAGNI)

- Per-account circuit breakers / rate limits. Breakers stay provider-level (`sms_providers.send_paused`, etc.) — revisit only if a real need appears.
- Secrets-manager / KMS integration. Env-var master key is sufficient for this scale; the versioned-ciphertext format (below) leaves the door open without building it now.
- Automatic master-key rotation tooling. The format supports it; the tooling is deferred.
- Changing how brands map to accounts beyond what selection requires (see §2).

---

## 2. Question 1 — Data model & stage selection

### The problem

Today the key and the number are resolved **independently**:
- Key: `resolveProviderApiKey(provider, brand-of-campaign)` — brand-specific row first, else the `brand_id IS NULL` provider-default.
- Number: the stage picks `provider_phone_id` directly; nothing ties it to the key that got resolved.

With one account per provider this can't mismatch. With multiple accounts it can: you could pick account B's number and still resolve account A's key. The fix is to make the number carry the account, and the account carry the key — the "existing sender-number stage-selection model" the user pointed at.

### Approaches

**Approach A — Extend `provider_credentials` into a labeled "account"; link numbers to it. (Recommended)**
- Add `label TEXT NOT NULL` (the human account name, e.g. "TextHub — Brand X main").
- **Drop** the `provider_credentials_provider_brand_uniq` index so N rows per provider are allowed. `brand_id` stays as optional metadata/filter, but **is no longer the selector**.
- Add `credential_id INTEGER REFERENCES provider_credentials(id)` to `provider_phones` — every number belongs to exactly one account.
- **Stage selection becomes single-axis:** the stage already picks `provider_phone_id`; at send time the key is resolved by `provider_phones.credential_id → provider_credentials`. Number → account → key, by construction. `resolveProviderApiKey(provider, brand)` is replaced by `resolveKeyForStage(stage)` that walks the number.
- Pros: smallest migration (extend one table + add one FK, no rename), reuses the existing credential API/UI/webhook-token/RLS, and matches the sender-number model exactly. A "credential row" *is* an account.
- Cons: the word "credential" is now doing "account" duty — mitigated by the `label` column and doc note.

**Approach B — New first-class `provider_accounts` table.**
- `provider_accounts (id, org_id, provider_id, name, api_key_encrypted, api_key_last4, inbound_webhook_token, status, …)` replaces `provider_credentials` as the credential holder; `provider_phones.account_id` FKs it.
- Pros: cleanest semantics — "account" is explicit.
- Cons: a rename ripples through ~15 files + tests (drain, kickoff, both pollers, both webhooks, the CDR poll, seed/verify scripts) for no behavioral gain over A. Bigger, riskier migration.

**Approach C — Explicit `provider_credential_id` on the stage, independent of the number.**
- Stage carries both `provider_credential_id` and `provider_phone_id`; a validator enforces they belong to the same account.
- Cons: two selectors kept consistent by validation rather than structure — exactly the mismatch risk we're trying to design out. Rejected.

### Recommendation: **Approach A.**
It gives multi-account with the least churn, keeps the number as the single selector, and structurally guarantees key+number+account cohesion. It also lands cleanly for the **upcoming TextHub sender-select feature** (per the `project_texthub_sender_id` note): each TextHub account simply gets its number rows, and the same number→account→key path applies. Until sender-select ships, a TextHub account's number row is a *selector-only* handle (it identifies the account; TextHub still binds the physical send-from account-side) — no special-casing needed in the resolution path.

### Transition detail (the one edge worth calling out)
Some TextHub stages today have **no** `provider_phone_id` (their key resolves purely by brand). Post-migration those can't walk number→account. So during migration the send path keeps a **two-step resolver**: prefer number→account→key; if the stage has no number, fall back to the legacy `(provider, brand)` default. Once every account has at least one number and stages are backfilled, the fallback is removed and `provider_phone_id` becomes required for tracked sends. This keeps the cutover downtime-free.

---

## 3. Question 2 — Encryption at rest

New module `lib/crypto/secret-box.ts` using Node's built-in `crypto` (no new dependency):

- `encryptSecret(plaintext) → string` producing a **versioned, self-describing blob**: `v1.<base64url(iv)>.<base64url(ciphertext)>.<base64url(authTag)>`. IV is a fresh 12-byte random per encryption; GCM auth tag gives tamper detection.
- `decryptSecret(blob) → string`, dispatching on the `v1.` prefix.
- Master key from a **new env var `PROVIDER_CREDENTIALS_KEY`** (32 bytes, base64) — set in Vercel + `.env.local`, never committed, added to `.env.example` (name + purpose only). App fails fast at startup if it's missing.
- The versioned prefix is the whole point of future-proofing: a later master-key rotation writes `v2.` blobs while `decryptSecret` still reads `v1.` — no big-bang re-encrypt required.

Schema changes on `provider_credentials` (target state — §4 covers the phased, no-downtime path there):
- `api_key_encrypted TEXT` holds the blob; the plaintext `api_key` column is retired at the end of the migration (§4 Phase 3). Decryption happens **only** inside `resolveKeyForStage` / the poller / the CDR poll, at send/poll time.
- Add `api_key_last4 TEXT NOT NULL` — stored plaintext (non-sensitive) so list/detail UIs show `••••1234` **without decrypting anything**. `maskApiKey()` already exists and computes last4; we persist it on write.

The column already has deny-by-default RLS (only the privileged server connection reads it) and is never serialized to the browser — those stay. Encryption is defense-in-depth on top.

---

## 4. Question 3 — No-downtime migration

Three backward-compatible phases; each deploy runs against the previous phase's data safely.

**Phase 1 — additive schema + dual-read (deploy, zero downtime).**
- Migration adds `api_key_encrypted`, `api_key_last4`, `label` (nullable initially), `provider_phones.credential_id`; drops the `(provider, brand)` unique index. All additive — old rows keep working.
- Deploy code that **reads either**: if `api_key_encrypted` is present, decrypt it; else fall back to plaintext `api_key`. Writes (new keys via UI) go to `api_key_encrypted` only.

**Phase 2 — backfill (idempotent script, run against prod after Phase 1 is live).**
- For each existing credential: encrypt `api_key` → `api_key_encrypted`, compute `api_key_last4`, set a default `label`. Link existing `provider_phones` to their provider's credential (there is exactly one per provider today, so the mapping is unambiguous — TextHub cred 2, Ahoi cred 262). Skip rows already encrypted (idempotent gate).
- Verify: every active credential has a non-null `api_key_encrypted` and decrypts to a value whose last4 matches `api_key_last4`.

**Phase 3 — cutover + cleanup (deploy, then a later migration).**
- Deploy code that reads **only** `api_key_encrypted` (remove the plaintext fallback); make `label`/`api_key_last4` `NOT NULL`.
- After a safety window, a final migration **drops the plaintext `api_key` column**. (Destructive — gated on explicit confirmation per project rules, run manually against prod.)

Downtime-free because Phase 1 reads both formats, Phase 2 only adds encrypted copies alongside the plaintext, and Phase 3 only flips once every row is confirmed encrypted.

---

## 5. Question 4 — Admin UI

Extend `ProviderCredentialsSection` on `/providers/[id]` and its existing `/api/providers/[providerId]/credentials/*` routes. No new page.

- **List:** each account shows `label`, `••••last4`, linked numbers, brand (if set), status, created — all from non-secret columns; the key is never fetched.
- **Add account:** `<FormDialog>` (per §9 conventions) with `label` (required), `api_key` (password input, required), optional `brand_id`. Server encrypts, stores `api_key_encrypted` + `api_key_last4`, returns only last4. Dropping the unique index lets N accounts coexist per provider.
- **Rotate key:** enter a new key → server re-encrypts and updates `api_key_last4`; the old ciphertext is overwritten. The field is never pre-filled (rotate = type the new value).
- **Edit:** label, brand, and number links (link/unlink `provider_phones` to this account).
- **Test:** reuse the existing `credentials/test` route (validates the key against the provider).
- **Archive** rather than hard-delete, matching the soft-delete convention.
- **Masking is absolute:** the plaintext key never crosses the wire in any response, including right after create.

### Open decision — permission level
Registry/config editing is `manager`+ today (§5). API keys are secrets, so there's a case for `admin`+. **Recommendation: `manager`+ for create/edit/rotate** (consistent with "edit config" and the current credential routes), unless you want secrets locked to `admin`+. Flagging for your call.

---

## 6. Decisions I need from you

1. **Data model (§2):** Approach A (extend `provider_credentials` into a labeled account — recommended) vs Approach B (new `provider_accounts` table)?
2. **Master-key env var name (§3):** `PROVIDER_CREDENTIALS_KEY` (recommended) or another name you prefer?
3. **Permission level for key management (§5):** `manager`+ (recommended) or `admin`+?
4. **Brand's role after multi-account (§2):** keep `brand_id` on the account as optional metadata/filter (recommended), or drop brand from credentials entirely now that the number is the selector?

---

## 7. What this doesn't touch

- The send/drain/kickoff pipeline logic beyond swapping the key-resolution call.
- Circuit breakers, rate limits, webhook-token model (already per-credential — carries over unchanged).
- Ahoi Phase 1 (independent; already merged/deployed).
- Number management itself (`provider_phones` CRUD) beyond adding the account link.
