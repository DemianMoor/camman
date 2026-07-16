# Multi-Account Provider Credentials + Encryption at Rest + Admin UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one provider hold N independent accounts (each its own API key + numbers), encrypt keys at rest, and manage them from the existing provider UI — migrated with zero downtime.

**Architecture:** Approach A from the spec — a `provider_credentials` row *is* an account (gains a `label`). Each `provider_phones` row links to one credential via `credential_id`. Stage selection stays single-axis (`provider_phone_id`); at send time the key is resolved **number → account → key** by walking the phone's `credential_id`. Keys are stored as AES-256-GCM ciphertext (ported crypto module) and decrypted only at send/poll time. A provider-scoped legacy fallback [(provider, brand) → default key] survives only while a provider has exactly one credential, keeping the cutover downtime-free.

**Tech Stack:** Next.js 16 (App Router) · TypeScript · Drizzle · Postgres (Supabase, prod project `rtdarhkkjwcetlmruftl`) · Zod · Node `crypto` (built-in, no new dep) · shadcn/ui.

## Global Constraints

- **Decisions (locked, from sign-off):** Data model = Approach A. Master-key env var = `PROVIDER_CREDENTIALS_KEY`. Permissions = **view at manager+, create/rotate/delete/link at admin+**. Brand = keep `brand_id` on the credential as optional metadata (legacy fallback needs it during migration).
- **Permission-gate flip is ATOMIC with the UI (Phase 3, Task 11) — NOT Phase 1.** Through Phases 1–2 every credential route keeps its EXISTING `providers.update` (manager+) gate: Phase 1 is a pure no-behavior-change encryption refactor that stays independently deployable. Task 11 flips ALL credential routes to the view/manage split (GET → `provider_credentials.view`; POST/PATCH/DELETE/test/register-callback → `provider_credentials.manage`) in the SAME change that adds the UI permission-gating — so a manager never sees an enabled button that 403s. The `provider_credentials.*` permissions (Task 2) therefore sit defined-but-unused until Task 11; that's intended.
- **`PROVIDER_CREDENTIALS_KEY` must be set in the Vercel/runtime env BEFORE Phase 2 backfill.** Pre-backfill, `api_key_encrypted` is null so no decrypt runs; post-backfill every poller/drain/route decrypt needs the key. The pollers now skip-with-warn (never crash) if a decrypt throws, but a missing key post-backfill means all credentials skip → no polling. Deploy checklist (Task 14) gates on this.
- **Crypto is written fresh, self-contained in CamMan.** `lib/crypto/secret-box.ts` uses Node's built-in `crypto` (AES-256-GCM) — no new dependency, no other repo. Provider keys live in CamMan's DB; the master key lives in CamMan's env (`PROVIDER_CREDENTIALS_KEY`). Standard GCM with the versioned `v1.<iv>.<ct>.<tag>` blob below — a well-established construction, not a novel scheme.
- **Sequencing guardrail (hard rule):** Never enable a 2nd credential for a provider while that provider has any active/tracked stage with a NULL `provider_phone_id`. The fallback resolver is only unambiguous while a provider has exactly one credential. Enforced structurally in Task 4 (fallback fires only when the provider has exactly one credential) and defensively in Task 10 (Add-account endpoint 409s if numberless tracked stages exist). Verified true today: 0 numberless txh stages.
- **Reconciled inventory (verified against prod 2026-07-15 — supersedes the spec's stale figures):**
  - TextHub: `provider_id 2` (`txh`), `credential_id 2` (brand NULL), phones `26, 27, 43`.
  - Ahoi: `provider_id 314` (`ahi`), `credential_id 262` (brand NULL), phones `44, 45`.
  - `snx` (1) and `smpl` (96): `supports_api_send=false`, **no** credentials → their phones keep `credential_id = NULL`, never linked.
- **Every API route resolves `org_id` server-side and filters every query by it** (multi-tenancy, CLAUDE.md §3). All credential/phone reads and writes below are `org_id`-scoped.
- **The plaintext key never crosses the wire** — not in list, not in detail, not immediately after create/rotate. Responses carry `••••last4` only.
- **Migrations are hand-authored** (db:generate blocks on a TTY prompt — see memory `project_migrations_handwritten`): write the SQL, clone `meta/000N_snapshot.json` forward, add the `_journal.json` entry, run `npm run db:migrate` against the prod `DATABASE_URL`, then `npx tsx scripts/verify-migration-integrity.ts`. Next free migration number is **0110**.
- **`db:migrate` hits shared PROD** (there is no separate prod DB). Schema changes are additive/backward-compatible per phase; the destructive column drop (Task 13) is gated on explicit user confirmation.
- **Docs are part of "done"** (CLAUDE.md "Documentation maintenance"). Task 14 updates them; the CHANGELOG line + "last updated" dates are mandatory.

---

## File Structure

**New files**
- `lib/crypto/secret-box.ts` — `encryptSecret`/`decryptSecret`, versioned `v1.` blob, master key from `PROVIDER_CREDENTIALS_KEY`. (ported)
- `scripts/test-secret-box.ts` — round-trip / tamper / wrong-key / format assertions (runnable, no DB).
- `scripts/backfill-provider-credentials-encryption.ts` — idempotent Phase-2 backfill (encrypt keys, set last4/label, link phones). `--apply` vs dry-run.
- `db/migrations/0110_provider_credentials_multi_account.sql` — Phase-1 additive schema.
- `db/migrations/0111_provider_credentials_tighten.sql` — Phase-3 NOT NULLs.
- `db/migrations/0112_provider_credentials_drop_plaintext.sql` — Phase-3 destructive drop (gated).
- `app/api/providers/[providerId]/credentials/[credentialId]/route.ts` — **add** `PATCH` (label/brand/phone links) + change DELETE to archive-or-delete; keep the file.

**Modified files**
- `db/schema.ts` — `provider_credentials` (+`api_key_encrypted`, `api_key_last4`, `label`; `api_key` nullable), `provider_phones` (+`credential_id`), drop the two unique indexes.
- `lib/sends/provider-credential.ts` — `resolveKeyForStage`, `resolveCredentialKeyById`, updated `hasResolvableCredential`; `maskApiKey` unchanged.
- `lib/sends/drain.ts` — swap key resolution to `resolveKeyForStage` (extend the existing `provider_phones` join to also carry `credential_id`).
- `lib/sends/poll-opt-outs.ts`, `lib/sends/ahoi-cdr-poll.ts` — decrypt `api_key_encrypted` (dual-read).
- `app/api/providers/[providerId]/credentials/route.ts` — POST writes encrypted + last4 + label; GET returns label/last4/linked-numbers.
- `app/api/providers/[providerId]/credentials/test/route.ts` — decrypt via `resolveCredentialKeyById`; gate at `provider_credentials.manage`.
- `app/api/providers/[providerId]/credentials/[credentialId]/register-callback/route.ts` — decrypt via `resolveCredentialKeyById`; gate at `provider_credentials.manage`.
- `lib/validators/providers.ts` — `providerCredentialSetSchema` (+`label`), new `providerCredentialUpdateSchema`.
- `lib/permissions.ts` — `provider_credentials.view` (manager+), `provider_credentials.manage` (admin+).
- `components/providers/provider-credentials-section.tsx` — account-shaped UI.
- `.env.example`, `docs/*` — env var + documentation.

---

# Phase 0 — Foundation (crypto + permissions)

### Task 1: Port the encryption module

**Files:**
- Create: `lib/crypto/secret-box.ts` (written fresh — Node built-in `crypto`, AES-256-GCM)
- Test: `scripts/test-secret-box.ts`

Write this fresh using Node's built-in `crypto` — self-contained in CamMan, no external repo, no new dependency. Standard AES-256-GCM with the versioned blob format below (a well-established construction). The interface and blob format are the contract the rest of the plan depends on.

**Interfaces:**
- Produces:
  - `encryptSecret(plaintext: string): string` → `"v1.<b64url(iv)>.<b64url(ciphertext)>.<b64url(authTag)>"`; fresh 12-byte random IV per call; AES-256-GCM.
  - `decryptSecret(blob: string): string` → throws on unknown version prefix, wrong key, or tampering (GCM auth failure).
  - `getMasterKey(): Buffer` (internal) — decodes `PROVIDER_CREDENTIALS_KEY` (base64, 32 bytes). Throws a clear startup error if missing/wrong length.

- [ ] **Step 1: Write the failing test** (`scripts/test-secret-box.ts`)

```ts
import assert from "node:assert";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-box";

// Requires PROVIDER_CREDENTIALS_KEY to be set in the environment.
function run() {
  // Round-trip
  const secret = "th_live_abcdef0123456789ABCDEF";
  const blob = encryptSecret(secret);
  assert.ok(blob.startsWith("v1."), `expected v1. prefix, got ${blob.slice(0, 8)}`);
  assert.strictEqual(decryptSecret(blob), secret, "round-trip must return the original");

  // Non-deterministic IV: two encryptions of the same plaintext differ
  assert.notStrictEqual(encryptSecret(secret), encryptSecret(secret), "IV must be random per call");

  // Tamper detection: flip a byte in the ciphertext segment → GCM auth fails
  const parts = blob.split(".");
  const tampered = [parts[0], parts[1], parts[2].slice(0, -2) + (parts[2].endsWith("A") ? "B" : "A"), parts[3]].join(".");
  assert.throws(() => decryptSecret(tampered), "tampered ciphertext must throw");

  // Unknown version prefix rejected
  assert.throws(() => decryptSecret("v2." + parts.slice(1).join(".")), "unknown version must throw");

  console.log("secret-box: all assertions passed");
}
run();
```

- [ ] **Step 2: Run it, expect FAIL** — Run: `npx tsx scripts/test-secret-box.ts`. Expected: module-not-found / assertion failure (no implementation yet).

- [ ] **Step 3: Port the implementation** into `lib/crypto/secret-box.ts` from the unified-admin module. Enforce: 32-byte key from `PROVIDER_CREDENTIALS_KEY` (base64), 12-byte IV, `aes-256-gcm`, 16-byte auth tag, `base64url` segment encoding, `v1.` prefix, fail-fast `getMasterKey()`.

- [ ] **Step 4: Generate a dev key and run the test**

```bash
# Dev-only key for .env.local (NEVER commit). 32 random bytes, base64.
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# → paste into .env.local as PROVIDER_CREDENTIALS_KEY=...
npx tsx scripts/test-secret-box.ts
```
Expected: `secret-box: all assertions passed`.

- [ ] **Step 5: Commit** — `git add lib/crypto/secret-box.ts scripts/test-secret-box.ts && git commit -m "feat(crypto): port AES-256-GCM secret-box for provider credentials"`

---

### Task 2: Add the two permissions

**Files:** Modify `lib/permissions.ts`

**Interfaces:**
- Produces: `Permission` literals `"provider_credentials.view"` (manager+) and `"provider_credentials.manage"` (admin+). Consumed by every credential route from Task 5 onward.

- [ ] **Step 1:** Add both literals to the `Permission` union (near the `providers.*` group).
- [ ] **Step 2:** Add `"provider_credentials.view"` to `managerPerms` (viewer/operator do NOT get it — secrets surface is manager+). Add `"provider_credentials.manage"` to `adminPerms`.
- [ ] **Step 3:** Sanity-check inheritance: `can("admin","provider_credentials.view")` is true via the manager→admin spread; `can("manager","provider_credentials.manage")` is false.

```ts
// quick inline check in a scratch tsx if desired:
import { can } from "@/lib/permissions";
console.assert(can("manager","provider_credentials.view") && !can("operator","provider_credentials.view"));
console.assert(can("admin","provider_credentials.manage") && !can("manager","provider_credentials.manage"));
```

- [ ] **Step 4: Commit** — `git commit -am "feat(permissions): add provider_credentials.view (manager+) and .manage (admin+)"`

---

# Phase 1 — Additive schema + dual-read (deployable, zero downtime)

### Task 3: Migration 0110 — additive schema

**Files:**
- Create: `db/migrations/0110_provider_credentials_multi_account.sql`
- Modify: `db/schema.ts` (provider_credentials + provider_phones), `db/migrations/meta/_journal.json`, clone `meta/0109_snapshot.json` → `meta/0110_snapshot.json` and edit it forward.

**Interfaces:**
- Produces columns: `provider_credentials.api_key_encrypted TEXT`, `provider_credentials.api_key_last4 TEXT`, `provider_credentials.label TEXT`, `provider_phones.credential_id INTEGER` (FK → `provider_credentials(id) ON DELETE SET NULL`). `provider_credentials.api_key` becomes nullable. Both unique indexes dropped.

- [ ] **Step 1: Write the migration SQL**

```sql
-- 0110_provider_credentials_multi_account.sql
-- Multi-account credentials + encryption-at-rest groundwork (Phase 1, additive).
-- Backward-compatible: existing plaintext rows keep working via dual-read.

-- 1. New columns (all nullable in Phase 1; tightened in 0111 after backfill).
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT;
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS api_key_last4 TEXT;
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS label TEXT;

-- 2. Allow encrypted-only writes: plaintext api_key no longer required.
ALTER TABLE provider_credentials ALTER COLUMN api_key DROP NOT NULL;

-- 3. Number -> account link.
ALTER TABLE provider_phones ADD COLUMN IF NOT EXISTS credential_id INTEGER
  REFERENCES provider_credentials(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS provider_phones_credential_id_idx ON provider_phones (credential_id);

-- 4. Allow N accounts per provider: drop the single-account uniques.
DROP INDEX IF EXISTS provider_credentials_provider_brand_uniq;
DROP INDEX IF EXISTS provider_credentials_provider_default_uniq;
```

- [ ] **Step 2: Update `db/schema.ts`** — in `provider_credentials`: change `api_key: text("api_key").notNull()` → `api_key: text("api_key")`; add `api_key_encrypted: text("api_key_encrypted")`, `api_key_last4: text("api_key_last4")`, `label: text("label")`; remove the two dropped `uniqueIndex(...)` entries and update the block comment (no longer "one key per provider"). In `provider_phones`: add `credential_id: integer("credential_id").references(() => provider_credentials.id, { onDelete: "set null" })` and `index("provider_phones_credential_id_idx").on(table.credential_id)`.

- [ ] **Step 3: Clone the snapshot + journal entry.** Copy `meta/0109_snapshot.json` to `meta/0110_snapshot.json`, edit it to reflect the schema above (the two new tables' columns/indexes), and append to `meta/_journal.json`:

```json
{ "idx": 110, "version": "7", "when": 1785888000000, "tag": "0110_provider_credentials_multi_account", "breakpoints": true }
```

- [ ] **Step 4: Apply + verify**

```bash
npm run db:migrate
npx tsx scripts/verify-migration-integrity.ts   # expect all-green (60/60)
```
Expected: migration 0110 applied; integrity chain clean.

- [ ] **Step 5: Confirm columns exist** — Run (read-only): `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='provider_credentials' AND column_name IN ('api_key','api_key_encrypted','api_key_last4','label');` Expected: `api_key` is_nullable=YES, the three new columns present.

- [ ] **Step 6: Commit** — `git commit -am "feat(db): 0110 multi-account credential columns + phone->credential link"`

---

### Task 4: Resolver — number → account → key (with provider-scoped fallback)

**Files:** Modify `lib/sends/provider-credential.ts`. Test: `scripts/test-resolve-key-for-stage.ts` (new).

**Interfaces:**
- Consumes: `decryptSecret` (Task 1).
- Produces:
  - `resolveKeyForStage(dbc, { orgId, providerId, brandId, providerPhoneId }): Promise<string | null>` — returns plaintext key. Order: (a) if `providerPhoneId` set and its phone has a `credential_id`, decrypt that credential's key; (b) **fallback ONLY when the provider has exactly one credential** → resolve legacy `(provider, brand)`/default, dual-reading `api_key_encrypted` (decrypt) else plaintext `api_key`; (c) else null.
  - `resolveCredentialKeyById(dbc, { orgId, credentialId }): Promise<string | null>` — dual-read decrypt for a specific credential (test route / pollers).
  - `hasResolvableCredential(dbc, { orgId, providerId, brandId, providerPhoneId }): Promise<boolean>` — mirrors `resolveKeyForStage`'s reachability without reading the secret.
  - `maskApiKey` — unchanged.

- [ ] **Step 1: Write the failing test.** Uses the two real prod-shaped rows (single-credential providers → fallback path) plus a synthetic two-credential provider (fallback must NOT fire). Run against a transaction that rolls back.

```ts
// scripts/test-resolve-key-for-stage.ts — structural assertions (no live send).
import assert from "node:assert";
import { db } from "@/db/client";
import { sql } from "drizzle-orm";
import { encryptSecret } from "@/lib/crypto/secret-box";
import { resolveKeyForStage } from "@/lib/sends/provider-credential";

async function run() {
  await db.transaction(async (tx) => {
    const org = (await tx.execute(sql`SELECT id FROM organizations LIMIT 1`)) as any as { id: string }[];
    const orgId = org[0].id;
    // Provider with ONE credential, key stored ENCRYPTED, phone linked to it.
    const prov = (await tx.execute(sql`INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
      VALUES (${"t_" + Math.floor(1)}, ${orgId}, 'T', true) RETURNING id`)) as any as { id: number }[];
    const pid = prov[0].id;
    const cred = (await tx.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, api_key_encrypted, api_key_last4, label)
      VALUES (${orgId}, ${pid}, ${encryptSecret("KEY-AAAA")}, 'AAAA', 'acct1') RETURNING id`)) as any as { id: number }[];
    const phone = (await tx.execute(sql`INSERT INTO provider_phones (org_id, provider_id, phone_number, credential_id)
      VALUES (${orgId}, ${pid}, '+15550000001', ${cred[0].id}) RETURNING id`)) as any as { id: number }[];

    // (a) number -> account -> key
    assert.strictEqual(await resolveKeyForStage(tx, { orgId, providerId: pid, brandId: null, providerPhoneId: phone[0].id }), "KEY-AAAA");
    // (b) no phone, single credential -> fallback resolves the same key
    assert.strictEqual(await resolveKeyForStage(tx, { orgId, providerId: pid, brandId: null, providerPhoneId: null }), "KEY-AAAA");

    // Add a SECOND credential -> fallback must NOT fire for a numberless stage.
    await tx.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, api_key_encrypted, api_key_last4, label)
      VALUES (${orgId}, ${pid}, ${encryptSecret("KEY-BBBB")}, 'BBBB', 'acct2')`);
    assert.strictEqual(await resolveKeyForStage(tx, { orgId, providerId: pid, brandId: null, providerPhoneId: null }), null,
      "ambiguous provider (2 creds) + no number must not fall back");
    // But the numbered stage still resolves deterministically.
    assert.strictEqual(await resolveKeyForStage(tx, { orgId, providerId: pid, brandId: null, providerPhoneId: phone[0].id }), "KEY-AAAA");

    // Legacy plaintext row still readable via dual-read.
    const prov2 = (await tx.execute(sql`INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
      VALUES (${"t2_" + Math.floor(1)}, ${orgId}, 'T2', true) RETURNING id`)) as any as { id: number }[];
    await tx.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, api_key) VALUES (${orgId}, ${prov2[0].id}, 'PLAIN-CCCC')`);
    assert.strictEqual(await resolveKeyForStage(tx, { orgId, providerId: prov2[0].id, brandId: null, providerPhoneId: null }), "PLAIN-CCCC");

    console.log("resolve-key-for-stage: all assertions passed");
    throw new Error("ROLLBACK"); // never persist test rows
  }).catch((e) => { if (e.message !== "ROLLBACK") throw e; });
}
run();
```

- [ ] **Step 2: Run it, expect FAIL** — `npx tsx scripts/test-resolve-key-for-stage.ts` → `resolveKeyForStage is not a function`.

- [ ] **Step 3: Implement.** Add to `lib/sends/provider-credential.ts`:

```ts
import { decryptSecret } from "@/lib/crypto/secret-box";

// Dual-read a single credential's key: prefer encrypted blob, else plaintext.
function readKey(row: { api_key_encrypted: string | null; api_key: string | null }): string | null {
  if (row.api_key_encrypted) return decryptSecret(row.api_key_encrypted);
  return row.api_key ?? null;
}

export async function resolveKeyForStage(
  dbc: DbOrTx,
  { orgId, providerId, brandId, providerPhoneId }:
    { orgId: string; providerId: number; brandId: number | null; providerPhoneId: number | null },
): Promise<string | null> {
  // (a) number -> account -> key
  if (providerPhoneId != null) {
    const rows = (await dbc.execute(sql`
      SELECT pc.api_key_encrypted, pc.api_key
      FROM provider_phones ph
      JOIN provider_credentials pc ON pc.id = ph.credential_id
      WHERE ph.id = ${providerPhoneId} AND ph.org_id = ${orgId} AND pc.org_id = ${orgId}
      LIMIT 1
    `)) as unknown as { api_key_encrypted: string | null; api_key: string | null }[];
    if (rows[0]) return readKey(rows[0]);
    // phone exists but no credential_id yet (pre-backfill) -> fall through to legacy
  }
  // (b) provider-scoped legacy fallback — ONLY when exactly one credential exists.
  const count = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM provider_credentials WHERE org_id = ${orgId} AND provider_id = ${providerId}
  `)) as unknown as { n: number }[];
  if ((count[0]?.n ?? 0) !== 1) return null;
  const rows = (await dbc.execute(sql`
    SELECT api_key_encrypted, api_key FROM provider_credentials
    WHERE org_id = ${orgId} AND provider_id = ${providerId}
      AND (brand_id = ${brandId} OR brand_id IS NULL)
    ORDER BY (brand_id IS NOT NULL) DESC
    LIMIT 1
  `)) as unknown as { api_key_encrypted: string | null; api_key: string | null }[];
  return rows[0] ? readKey(rows[0]) : null;
}

export async function resolveCredentialKeyById(
  dbc: DbOrTx,
  { orgId, credentialId }: { orgId: string; credentialId: number },
): Promise<string | null> {
  const rows = (await dbc.execute(sql`
    SELECT api_key_encrypted, api_key FROM provider_credentials
    WHERE id = ${credentialId} AND org_id = ${orgId} LIMIT 1
  `)) as unknown as { api_key_encrypted: string | null; api_key: string | null }[];
  return rows[0] ? readKey(rows[0]) : null;
}
```

Update `hasResolvableCredential` to accept `providerPhoneId` and mirror the same reachability (phone→credential present, OR exactly-one-credential fallback). Keep its no-secret guarantee (select `1`, never the key columns).

- [ ] **Step 4: Run it, expect PASS** — `npx tsx scripts/test-resolve-key-for-stage.ts` → `resolve-key-for-stage: all assertions passed`.

- [ ] **Step 5: Commit** — `git commit -am "feat(sends): resolveKeyForStage (number->account->key) with single-credential fallback + dual-read"`

---

### Task 5: Wire the drain to `resolveKeyForStage`

**Files:** Modify `lib/sends/drain.ts` (context query ~185-214, resolution ~235-240). Verify with `scripts/verify-drain.ts`.

**Interfaces:**
- Consumes: `resolveKeyForStage` (Task 4). The drain's context query already `LEFT JOIN provider_phones pp ON pp.id = s.provider_phone_id`.

- [ ] **Step 1:** Add `s.provider_phone_id AS provider_phone_id` to the context SELECT and `provider_phone_id: number | null` to its row type.
- [ ] **Step 2:** Replace the `resolveProviderApiKey(...)` call at ~235 with:

```ts
const apiKey = await resolveKeyForStage(dbc, {
  orgId: stage.org_id,
  providerId: stage.provider_id,
  brandId: stage.brand_id,
  providerPhoneId: stage.provider_phone_id,
});
if (!apiKey) return { ok: false, reason: "no_credentials", ...EMPTY };
```
Update the import from `resolveProviderApiKey` → `resolveKeyForStage`.

- [ ] **Step 3:** Grep for other `resolveProviderApiKey` importers: `Grep resolveProviderApiKey`. Expected only drain.ts. If none remain, delete the now-dead `resolveProviderApiKey` export from `provider-credential.ts`.
- [ ] **Step 4: Run** `npx tsx scripts/verify-drain.ts` (test seam injects a sender — does not hit a live provider). Expected: green.
- [ ] **Step 5: Commit** — `git commit -am "refactor(drain): resolve send key via number->account->key"`

---

### Task 6: Decrypt at the remaining read sites (dual-read)

**Files:** Modify `lib/sends/poll-opt-outs.ts` (~366 loader), `lib/sends/ahoi-cdr-poll.ts` (~104 loader), `app/api/providers/[providerId]/credentials/test/route.ts` (~73), `app/api/providers/[providerId]/credentials/[credentialId]/register-callback/route.ts`.

**Interfaces:** Consumes `resolveCredentialKeyById` / `readKey` semantics (Task 4). Every site that reads `pc.api_key` must instead dual-read.

- [ ] **Step 1 (pollers):** In each loader that `SELECT ... pc.api_key ...`, also select `pc.api_key_encrypted`, and in the consuming loop compute the key via `decryptSecret(row.api_key_encrypted) ?? row.api_key`. (Both pollers iterate all credentials for the provider — decrypt per row.) Keep the `CredentialRow` type but replace `api_key` with a resolved plaintext value assigned right after load, so downstream `cred.api_key` usage is unchanged.
- [ ] **Step 2 (test route):** Replace the direct `provider_credentials.api_key` select with `resolveCredentialKeyById(db, { orgId, credentialId })` after confirming ownership (keep the existing ownership/provider/org join, but select only non-secret columns for the 404 check, then resolve the key separately). Change the gate `can(role, "providers.update")` → `can(role, "provider_credentials.manage")`.
- [ ] **Step 3 (register-callback route):** Same decrypt swap + gate change to `provider_credentials.manage`.
- [ ] **Step 4: Verify** `npx tsx scripts/verify-poll-opt-outs.ts` (dual-read on today's still-plaintext rows must return the same keys). Expected: green.
- [ ] **Step 5: Commit** — `git commit -am "feat(sends): dual-read (decrypt) api keys at poller/test/register read sites"`

---

### Task 7: Write path — POST stores encrypted + last4 (Phase-1-safe: keeps upsert semantics)

**Files:** Modify `app/api/providers/[providerId]/credentials/route.ts` (POST + GET), `lib/validators/providers.ts`, `db/schema.ts`.

**⚠️ Phase-1-deployability constraint (why this differs from the original spec framing):** Phase 1 deploys to prod while the CURRENT credentials UI is still live (the new multi-account UI is Task 11). That UI does **rotate-via-POST** and sends **no `label`**. So POST must **stay upsert-by-(provider, brand)** and must NOT require `label` — otherwise (a) every rotate 400s on the missing label, and (b) create-only turns a rotate into a *duplicate* credential row, pushing a provider to 2 credentials and breaking `resolveKeyForStage`'s `count === 1` legacy fallback (phones aren't linked to credentials until the Task 8 backfill) → sends break. **Create-only + required-`label` + the 2nd-account guardrail move to Task 11**, landing atomically with the new UI (which rotates via PATCH). Task 7 is a pure encryption-at-rest upgrade of the existing write path.

**Interfaces:**
- Consumes `encryptSecret`, `maskApiKey`. Produces rows with `api_key_encrypted` set, `api_key` NULL, `api_key_last4` set, `label` populated (derived default).

- [ ] **Step 1 (validator):** Leave `providerCredentialSetSchema` shape unchanged (`{ brand_id, api_key }`) — do NOT add a required `label` (would break the live UI's POST). Optionally accept `label: z.string().trim().min(1).max(120).optional()` for forward-compat, but the route derives a default when absent.
- [ ] **Step 1b (schema flip — earned here):** In `db/schema.ts` change `api_key: text("api_key").notNull()` → `api_key: text("api_key")`. Task 3 deliberately kept the Drizzle type non-null to keep the tree compiling through Tasks 3–6; this is the task that writes NULL into `api_key`, so the nullable type is earned here. (The DB column has been nullable since migration 0110.) `resolveKeyForStage`/`decryptCredentialKey` typing over raw SQL is unaffected; only Drizzle inserts/updates gain the nullable type.
- [ ] **Step 2 (POST):** Keep the EXISTING upsert-by-(provider, brand) transaction (find existing row for this provider+brand; update if present, else insert). Only change what is written: compute `const { last4 } = maskApiKey(api_key); const enc = encryptSecret(api_key);`. On **insert** set `{ org_id, provider_id, brand_id, api_key_encrypted: enc, api_key_last4: last4, label: <derived> }` (do NOT set `api_key`). On **update (rotate)** set `{ api_key_encrypted: enc, api_key_last4: last4, api_key: null, label: sql\`COALESCE(label, <derived>)\`, updated_at: new Date() }` (never overwrite an existing label). Derived default: `brand_id != null ? <brand name, already fetched for the ownership check> : "Default"`. **Gate: KEEP `can(role,"providers.update")`** — permission flip deferred to Task 11. Do not change gates, do not add the 2nd-account guardrail here (that's Task 10/11).

- [ ] **Step 3 (GET):** **Gate: KEEP `can(role,"providers.update")`** (permission flip deferred to Task 11). Select `id, brand_id, label, api_key_last4, updated_at` + a linked-numbers subquery: `(SELECT count(*) FROM provider_phones ph WHERE ph.credential_id = pc.id) AS linked_numbers`. Return `last4`/`masked` from `api_key_last4` (fallback: if `api_key_last4` is NULL — pre-backfill row — derive from plaintext via `maskApiKey`, still never returning the key). **No decryption in GET.**
- [ ] **Step 4: Manual verify** (local dev, admin session): POST a new key → 200, response masked; re-fetch GET → row shows label + `••••last4`, `linked_numbers`. Confirm DB row has `api_key_encrypted` non-null and `api_key` null: `SELECT id, label, api_key IS NULL AS plaintext_cleared, api_key_encrypted IS NOT NULL AS enc FROM provider_credentials ORDER BY id DESC LIMIT 1;`
- [ ] **Step 5: Commit** — `git commit -am "feat(api): credentials POST stores encrypted+last4+label; GET returns label/last4/linked-numbers"`

**➡️ Phase 1 is now independently deployable.** Old rows read via dual-read; new writes are encrypted. No backfill required for correctness. **Deploy Phase 1 before running Task 8.**

---

# Phase 2 — Backfill (idempotent script, run against prod after Phase 1 is live)

### Task 8: Encrypt existing keys + link phones

**Files:** Create `scripts/backfill-provider-credentials-encryption.ts`.

**Interfaces:** Consumes `encryptSecret`, `maskApiKey`. Idempotent gate: `api_key_encrypted IS NULL AND api_key IS NOT NULL`.

- [ ] **Step 1: Write the script.** Two modes: dry-run (default, prints planned changes) and `--apply`. Logic:
  1. **Encrypt keys:** for every `provider_credentials` row where `api_key_encrypted IS NULL AND api_key IS NOT NULL`: set `api_key_encrypted = encryptSecret(api_key)`, `api_key_last4 = maskApiKey(api_key).last4`, `label = COALESCE(label, <provider.name> || ' — Default')`. Do **not** null `api_key` yet (Phase 3 drops it).
  2. **Link phones:** for every `sms_providers` with exactly one credential, set `provider_phones.credential_id = <that credential>` for all its phones where `credential_id IS NULL`. If a provider has 0 or ≠1 credentials, **skip and log** (snx/smpl have 0 → skipped by design; never guess a mapping).
  3. **Verify:** for each touched credential, assert `decryptSecret(api_key_encrypted) === api_key` and `right(api_key,4) === api_key_last4`; abort with a clear error if any mismatch.
- [ ] **Step 2: Encode the reconciled expected end-state as an assertion** (guards against a stale/drifted DB): after apply, assert exactly — TextHub `provider 2 / credential 2` linked to phones `{26,27,43}`; Ahoi `provider 314 / credential 262` linked to phones `{44,45}`; `snx`/`smpl` phones remain `credential_id IS NULL`. Print the reconciliation table.
- [ ] **Step 3: Dry-run against prod** — `npx tsx scripts/backfill-provider-credentials-encryption.ts`. Expected output: 2 credentials to encrypt (cred 2, cred 262), 5 phones to link (26,27,43 → cred 2; 44,45 → cred 262), snx/smpl skipped. **Stop and review with the user before applying** (writes to shared prod).
- [ ] **Step 4: Apply** — `npx tsx scripts/backfill-provider-credentials-encryption.ts --apply`. Expected: verification passes; reconciliation assertions hold.
- [ ] **Step 5: Post-check (read-only)** — Run: `SELECT id, label, api_key_encrypted IS NOT NULL AS enc, api_key_last4 FROM provider_credentials ORDER BY id;` and `SELECT id, provider_id, credential_id FROM provider_phones WHERE provider_id IN (2,314) ORDER BY id;`. Expected: both creds encrypted+labeled; phones 26/27/43→2, 44/45→262.
- [ ] **Step 6: Re-run idempotency** — `npx tsx scripts/backfill-provider-credentials-encryption.ts --apply` again → "0 credentials to encrypt, 0 phones to link". Confirms the gate.
- [ ] **Step 7: Commit** — `git commit -am "feat(scripts): idempotent backfill — encrypt credentials + link phones to accounts"`

---

# Phase 3 — Admin UI + account model

### Task 9: PATCH route — edit label / brand / linked numbers; archive

**Files:** Modify `app/api/providers/[providerId]/credentials/[credentialId]/route.ts` (add PATCH; adjust DELETE gate), `lib/validators/providers.ts`.

**Interfaces:**
- Produces: `PATCH /api/providers/[providerId]/credentials/[credentialId]` accepting `{ label?, brand_id?, phone_ids? }`. `phone_ids` is the complete set of `provider_phones.id` that should belong to this credential (org+provider scoped); the route sets `credential_id` on those and clears it on this credential's phones not in the set.

- [ ] **Step 1 (validator):** Add `providerCredentialUpdateSchema = z.object({ label: z.string().trim().min(1).max(120).optional(), brand_id: z.number().int().positive().nullable().optional(), phone_ids: z.array(z.number().int().positive()).max(200).optional() }).refine(has-at-least-one-field)`.
- [ ] **Step 2 (PATCH):** **Gate: `can(role,"providers.update")` for now** (permission flip deferred to Task 11). Verify the credential belongs to (org, provider). If `phone_ids` present, verify every id is a `provider_phones` row in this org+provider (reject otherwise, 400). In a transaction: update label/brand if present; then `UPDATE provider_phones SET credential_id = <cred> WHERE id = ANY(phone_ids)` and `UPDATE provider_phones SET credential_id = NULL WHERE credential_id = <cred> AND id <> ALL(phone_ids)`. Return the masked row shape (label, last4, brand, linked_numbers).
- [ ] **Step 3 (DELETE):** **Gate: `can(role,"providers.update")` for now** (permission flip deferred to Task 11). Follow soft-delete convention: since `provider_credentials` has no `status`/`archived_at` today, keep hard-DELETE but first null out `credential_id` on its phones (the FK is `ON DELETE SET NULL`, so this happens automatically — verify) and warn in the response body that linked numbers are unlinked. (Archive-vs-delete is a UI affordance; DB stays hard-delete to match the existing table shape — no new columns for YAGNI.)
- [ ] **Step 4: Manual verify** (admin session): create 2 credentials for a test provider; PATCH cred A with `phone_ids: [x]`; GET → A shows 1 linked number, and the number's `credential_id` = A. PATCH A with `phone_ids: []` → number unlinked.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): PATCH credential (label/brand/number links) + manage-gated DELETE"`

---

### Task 10: Convert POST to multi-account create-only + sequencing guardrail

**Files:** Modify `app/api/providers/[providerId]/credentials/route.ts` (POST), `lib/validators/providers.ts`.

**⚠️ This task, together with Task 11's new UI, forms one Phase-3 deploy** — they ship together so the live UI is never mismatched. Task 7 deliberately kept POST as upsert-by-(provider,brand) for Phase-1 deployability; THIS task converts it:
- **Create-only:** POST always INSERTs a new credential row (no more upsert-by-brand). Rotation now goes through the Task 9 PATCH route, which the new UI (Task 11) uses.
- **`label` required:** add `label: z.string().trim().min(1).max(120)` to `providerCredentialSetSchema` (the new UI always sends it).
- Plus the guardrail below.

**Interfaces:** Produces a 409 when a 2nd+ account would make numberless stages ambiguous.

- [ ] **Step 1: Write the guard test** (`scripts/test-second-account-guard.ts`): in a rolled-back tx, create a provider + 1 credential + 1 tracked stage with NULL `provider_phone_id`; assert the "would this be the 2nd credential AND do numberless tracked stages exist" predicate returns true (block). Then set the stage's `provider_phone_id`; assert predicate false (allow).
- [ ] **Step 2: Implement the guard in POST:** before inserting, if the provider already has ≥1 credential, run:

```sql
SELECT count(*)::int AS n FROM campaign_stages s
WHERE s.sms_provider_id = ${providerId}
  AND s.provider_phone_id IS NULL
  AND s.status IN ('draft','pending','sent');  -- send-eligible states
```
If `n > 0`, return `apiError(409, "Assign numbers to all existing stages for this provider before adding a second account", API_ERROR_CODES.CONFLICT, { reason: "numberless_stages_block_multi_account", count: n })`. (Today `n = 0` for txh, so a 2nd TextHub account is allowed immediately.)

- [ ] **Step 3: Run** `npx tsx scripts/test-second-account-guard.ts` → passes.
- [ ] **Step 4: Commit** — `git commit -am "feat(api): block a 2nd provider account while numberless send-eligible stages exist"`

---

### Task 11: Account-shaped UI

**Files:** Modify `components/providers/provider-credentials-section.tsx`.

**Interfaces:** Consumes GET (label, last4, linked_numbers, brand), POST (create: label+api_key+brand), PATCH (edit label/brand/numbers), DELETE, `test`, `register-callback`. Follows CLAUDE.md §9: `<FormDialog>` for inputs, `<AlertDialog>` for confirms, required asterisk, sonner toasts, permission-gated actions.

- [ ] **Step 1:** Update the `Cred` type: `{ id, brand_id, brand_name, label, last4, masked, linked_numbers, updated_at }`. Fetch a provider-phones list for the provider (new `useApiCall` to the existing phones list endpoint) to populate the number-link multi-select.
- [ ] **Step 2:** Table columns → **Account** (`label`), **Key** (`••••last4`), **Numbers** (linked count / names), **Brand**, **Updated**, actions. Drop the "one default + per-brand" scoping logic and the `addableBrands`/`hasDefault` gating (multi-account: always allow "Add account").
- [ ] **Step 3: Add-account dialog** (`FormDialog`): `label` (required, asterisk), `api_key` (password, required, asterisk), `brand` (optional select incl. "None"), optional numbers `<MultiSelectPicker>` (provider's unlinked phones). Submit → POST (label, api_key, brand_id); on 409 `numberless_stages_block_multi_account`, toast the returned message. Then, if numbers chosen, PATCH the new credential with `phone_ids`.
- [ ] **Step 4: Rotate dialog:** unchanged UX (type new key) → PATCH is not used for rotation; rotation posts the new key to a rotate endpoint. Simplest: rotation = POST is create-only now, so add rotation to PATCH? No — rotation replaces the secret. Add `api_key` (optional) to `providerCredentialUpdateSchema` and PATCH: if present, re-encrypt + update last4. Wire the Rotate dialog to PATCH `{ api_key }`. (Update Task 9 Step 1 validator to include optional `api_key` and Step 2 to handle it.)
- [ ] **Step 5: Edit dialog:** label + brand + numbers (`MultiSelectPicker`) → PATCH.
- [ ] **Step 6: Flip ALL credential permission gates atomically (server + UI).** This is the single point where the view/manage split lands, so managers never see a button that 403s.
  - **Server routes** — update every credential route gate to the new model in this task: `GET /credentials` → `can(role,"provider_credentials.view")`; `POST /credentials`, `PATCH`/`DELETE /credentials/[credentialId]`, `POST /credentials/test`, `POST /credentials/[credentialId]/register-callback` → `can(role,"provider_credentials.manage")`. (These currently sit on `providers.update` from Phases 1–3a.) Update each route's stale "manager+" doc comment to "admin+ (provider_credentials.manage)" / "manager+ (provider_credentials.view)" accordingly.
  - **UI** — gate the mutate buttons (Add/Rotate/Edit/Delete/Send test/STOP callback) behind a `canManageCredentials = can(role,'provider_credentials.manage')` prop passed from the server page; the list is visible at `provider_credentials.view` (manager+). Fix the now-stale gating on the provider page (`app/(protected)/providers/[id]/page.tsx`) so the credentials section + its Send-test/STOP-callback buttons derive from the new prop, not the old `canUpdateProvider` (`providers.update`). Update the stale "API keys — manager+ only" comment there.
- [ ] **Step 7: Manual verify** in the running app (admin): add two TextHub accounts with distinct labels + linked numbers; rotate one; confirm masking everywhere; confirm a manager session sees the list but no action buttons. Confirm no plaintext key appears in any network response (check devtools).
- [ ] **Step 8: Commit** — `git commit -am "feat(ui): account-shaped provider credentials (label + linked numbers + manage gating)"`

---

# Phase 3b — Cutover + cleanup

### Task 12: Migration 0111 — tighten + drop plaintext fallback

**Files:** Create `db/migrations/0111_provider_credentials_tighten.sql`; modify `db/schema.ts`, `lib/sends/provider-credential.ts` (+ journal/snapshot).

**Precondition:** Task 8 applied in prod and post-check green (every credential encrypted + labeled).

- [ ] **Step 1: SQL** —
```sql
-- 0111_provider_credentials_tighten.sql
ALTER TABLE provider_credentials ALTER COLUMN api_key_last4 SET NOT NULL;
ALTER TABLE provider_credentials ALTER COLUMN label SET NOT NULL;
ALTER TABLE provider_credentials ALTER COLUMN api_key_encrypted SET NOT NULL;
```
- [ ] **Step 2:** Update `db/schema.ts` (`.notNull()` on those three). Clone snapshot → `0111_snapshot.json`, journal entry idx 111.
- [ ] **Step 3:** In `readKey`, drop the plaintext branch (encrypted-only): `return decryptSecret(row.api_key_encrypted)`. Remove `api_key` from the dual-read selects. The single-credential fallback in `resolveKeyForStage` stays (it now reads only encrypted).
- [ ] **Step 4: Apply + verify** — `npm run db:migrate && npx tsx scripts/verify-migration-integrity.ts`. Re-run `verify-drain.ts`, `verify-poll-opt-outs.ts`, `test-resolve-key-for-stage.ts` → green.
- [ ] **Step 5: Commit** — `git commit -am "feat(db): 0111 tighten credential NOT NULLs + encrypted-only reads"`

---

### Task 13: Migration 0112 — drop the plaintext column (GATED, destructive)

**Files:** Create `db/migrations/0112_provider_credentials_drop_plaintext.sql`; modify `db/schema.ts`.

**⚠️ Destructive. Do NOT run without explicit user confirmation (CLAUDE.md §11). Run only after a safety window with Phase-3b stable in prod.**

- [ ] **Step 1: SQL** — `ALTER TABLE provider_credentials DROP COLUMN api_key;`
- [ ] **Step 2:** Remove `api_key` from `db/schema.ts`. Clone snapshot → `0112_snapshot.json`, journal idx 112.
- [ ] **Step 3:** Confirm no code references `provider_credentials.api_key` remain: `Grep "api_key\b" lib app scripts` (expect only `api_key_encrypted`/`api_key_last4`/request-body `api_key`). 
- [ ] **Step 4: Apply + verify** (after confirmation) — `npm run db:migrate && npx tsx scripts/verify-migration-integrity.ts`.
- [ ] **Step 5: Commit** — `git commit -am "feat(db): 0112 drop plaintext provider_credentials.api_key"`

---

# Docs & env

### Task 14: Documentation + env var (part of "done")

**Files:** `.env.example`, `docs/03-data-model.md` (+ ERD), `docs/04-features/sms-send-pipeline.md` (key resolution), `docs/05-flows.md` (number→account→key sequence), `docs/06-integrations.md` (`PROVIDER_CREDENTIALS_KEY`), `docs/07-conventions.md` (account model + `v1.` blob format + sequencing guardrail), `docs/08-local-setup.md` (generate the key), `docs/security-notes.md` (encryption-at-rest now exists — supersede the plaintext tradeoff note), `docs/CHANGELOG.md`.

- [ ] **Step 1:** `.env.example` — add `PROVIDER_CREDENTIALS_KEY=` with a comment: "32-byte base64 master key for provider-credential encryption. Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\". Never commit the value." Set it in Vercel (all envs) before deploying Phase 1.
- [ ] **Step 2:** Update `provider_credentials` in `docs/03-data-model.md` + Mermaid ERD (new columns, `provider_phones.credential_id` edge, dropped uniques). Update `docs/security-notes.md` to state keys are now AES-256-GCM at rest.
- [ ] **Step 3:** `docs/07-conventions.md` — document: account model (credential = account, `label`), `v1.<iv>.<ct>.<tag>` blob format + versioned rotation story, number→account→key resolution, single-credential fallback, and the multi-account sequencing guardrail.
- [ ] **Step 4:** `docs/05-flows.md` — sequence diagram for send-time key resolution.
- [ ] **Step 5:** `docs/CHANGELOG.md` — append `2026-07-15 — Multi-account provider credentials + AES-256-GCM encryption at rest + account-shaped admin UI — updated 03-data-model, 04-features/sms-send-pipeline, 05-flows, 06-integrations, 07-conventions, 08-local-setup, security-notes`. Bump "last updated" on every doc touched.
- [ ] **Step 6: Commit** — `git commit -am "docs: multi-account credentials + encryption at rest"`

---

## Self-Review

**Spec coverage:** §2 data model (Approach A) → Tasks 3,4,9,10,11. §3 encryption → Tasks 1,3,7. §4 no-downtime migration (3 phases) → Phase 1 (3,4,5,6,7), Phase 2 (8), Phase 3b (12,13). §5 admin UI → Tasks 9,10,11. Decisions 1-4 → Global Constraints. Three folded-in additions → crypto port (Task 1 + constraint), reconciled inventory (Task 8 assertion + constraint), sequencing guardrail (Task 4 structural + Task 10 defensive). Docs → Task 14.

**Corrections vs spec (verified against prod, not the doc's figures):**
- Two unique indexes dropped, not one (`_provider_brand_uniq` **and** `_provider_default_uniq`).
- `api_key` is `NOT NULL` today → Phase 1 drops that constraint so encrypted-only writes work.
- **Zero** numberless TextHub stages exist (all 341 have a phone; the only 4 numberless are cancelled `snx`). The spec's "two-step transition for numberless TextHub stages" is therefore a safety net, not a data migration — existing-stage backfill is a no-op. The fallback is scoped to single-credential providers so it can never mis-resolve once a 2nd account is added.
- Permission tiers implemented via two new literals (`provider_credentials.view`/`.manage`) since no admin-tier providers permission existed.

**No open dependencies:** crypto is written fresh in-repo (Task 1) — execution proceeds straight through in task order.

**Prod gates (explicit user go required, show SQL + read-only checks first):** migration 0110 apply (Task 3 Step 4), backfill apply (Task 8 Step 4), migration 0111 apply (Task 12 Step 4), and the destructive 0112 column drop (Task 13). Cutover stays strictly ordered: Phase 1 additive+dual-read deploys and runs green → Phase 2 backfill runs and verifies every row decrypts to its last4 → Phase 3b encrypted-only cutover → 0112 drop only after a safety window.
