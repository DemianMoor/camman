# Ahoi Provider — Section 1 (Adapter Skeleton + Data Model) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the provider-adapter seam (interface + registry + TextHub adapter wrapper + Ahoi skeleton), wire the drain to resolve providers through it, and seed the Ahoi provider/number/credential — with TextHub's send path unchanged and `SEND_ENABLED` off.

**Architecture:** A thin `SmsProviderAdapter` interface (`lib/sends/providers/`) with a registry keyed by `sms_providers.sms_provider_id`. The raw TextHub HTTP client stays put (byte-for-byte); a wrapper adapter implements the interface over it. The drain resolves `getAdapter(providerKey)` at one point and calls `adapter.send(...)`/`adapter.buildRedactedRequest(...)`, preserving the injected-`Sender` test seam. Ahoi gets a skeleton adapter (recipient-format conversion real; send/parse deferred to later sections) plus seeded provider data.

**Tech Stack:** Next.js 16 · TypeScript · Drizzle ORM · Postgres (Supabase) · `tsx` test scripts (no vitest/jest in this repo — tests are `scripts/test-*.ts` run via `npx tsx`).

## Global Constraints

- `SEND_ENABLED` stays **OFF** the entire phase (env flag; never flipped in this plan).
- **Do not disturb TextHub's proven send/suppression path** — raw client `lib/sends/texthub.ts` internals unchanged (G2).
- **G1** webhook auth = path token only (not relevant until Section 3; no webhook here).
- **G2** TextHub suppressed-status flows through unchanged after wrapping (regression test in Task 3).
- **G3** unknown provider key = clean per-stage refusal, never an uncaught throw that kills the drain run.
- Provider is data: reuse `sms_providers` / `provider_phones` / `provider_credentials`; **zero new provider tables** in Section 1.
- Migrations are **hand-authored**, not generated; after apply run `npx tsx scripts/verify-migration-integrity.ts`. `DATABASE_URL` points at shared prod — seed is idempotent and additive.
- Numbers are 10-digit no `+1` on the Ahoi wire; contacts are stored E.164 (`+1XXXXXXXXXX`).

---

## File Structure

- Create `lib/sends/providers/types.ts` — shared types: `SendSmsResult` (re-exported), `NormalizedSendParams`, `RawWebhook`, `DlrEvent`, `InboundEvent`, and the `SmsProviderAdapter` interface. One responsibility: the provider contract.
- Create `lib/sends/providers/texthub.ts` — TextHub adapter wrapping the existing raw client. One responsibility: adapt TextHub → interface.
- Create `lib/sends/providers/ahoi.ts` — Ahoi adapter skeleton (recipient conversion real; send/parse throw `not_implemented` until Sections 2–3). One responsibility: Ahoi wire specifics.
- Create `lib/sends/providers/registry.ts` — `getAdapter(key)` + `UnknownProviderError`. One responsibility: provider lookup.
- Modify `lib/sends/texthub.ts` — **internals unchanged**; only `export type SendSmsResult` re-point (see Task 1) if needed. Keep `buildSendUrl`/`sendSms`/`isSuppressedStatus` exactly as-is.
- Modify `lib/sends/drain.ts` — resolve adapter via registry; call `adapter.buildRedactedRequest`; keep injected `Sender` default = resolved adapter's `send`.
- Create `db/migrations/0107_seed_ahoi_provider.sql` — idempotent seed of the Ahoi `sms_providers` row (number + credential seeded via a script, since they carry secrets/env, see Task 4).
- Create `scripts/seed-ahoi-number-credential.ts` — idempotent seed of the approved `provider_phones` + `provider_credentials` (reads token from `AHOI_API_TOKEN`).
- Create tests: `scripts/test-ahoi-registry.ts`, `scripts/test-ahoi-recipient.ts`, `scripts/test-drain-adapter-seam.ts`, `scripts/test-ahoi-seed.ts`.

---

## Task 1: Provider contract + registry + TextHub adapter

**Files:**
- Create: `lib/sends/providers/types.ts`, `lib/sends/providers/texthub.ts`, `lib/sends/providers/registry.ts`
- Modify: `lib/sends/texthub.ts` (only if `SendSmsResult` is relocated — see Step 3)
- Test: `scripts/test-ahoi-registry.ts`

**Interfaces:**
- Consumes: existing raw client `lib/sends/texthub.ts` — `sendSms(params)`, `buildSendUrl(params)`, `isSuppressedStatus`, `SendSmsResult`.
- Produces:
  - `type NormalizedSendParams = { apiKey: string; text: string; recipientE164: string; senderNumber: string | null; leadId?: string | null }`
  - `interface SmsProviderAdapter { key: "texthub" | "ahoi"; send(p: NormalizedSendParams): Promise<SendSmsResult>; buildRedactedRequest(p: NormalizedSendParams): string; toProviderRecipient(e164: string): string; parseDlr(raw: RawWebhook): DlrEvent | null; parseInbound(raw: RawWebhook): InboundEvent | null }`
  - `type RawWebhook = { query: Record<string,string>; body: string; headers: Record<string,string> }`
  - `type DlrEvent = { providerUuid: string; sendStatus: string; status: string; smppStatus: string | null; smppCode: string | null; error: string | null }`
  - `type InboundEvent = { source: string; destination: string; message: string; type: string; cost: string | null }`
  - `function getAdapter(key: string): SmsProviderAdapter` (throws `UnknownProviderError`)
  - `class UnknownProviderError extends Error`

- [ ] **Step 1: Write the failing test** — `scripts/test-ahoi-registry.ts`

```ts
// Registry resolves known providers and rejects unknown ones cleanly.
// Run: npx tsx scripts/test-ahoi-registry.ts
import { getAdapter, UnknownProviderError } from "@/lib/sends/providers/registry";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

const th = getAdapter("texthub");
check("texthub adapter resolves", th.key === "texthub");
const ah = getAdapter("ahoi");
check("ahoi adapter resolves", ah.key === "ahoi");

let threw: unknown = null;
try { getAdapter("nope"); } catch (e) { threw = e; }
check("unknown key throws UnknownProviderError", threw instanceof UnknownProviderError);
check("texthub.toProviderRecipient is identity", th.toProviderRecipient("+15551234567") === "+15551234567");

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
```

Note: `@/` path alias resolves under `tsx` via the repo's tsconfig `paths`; existing `scripts/test-*.ts` import `@/lib/...` the same way.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-ahoi-registry.ts`
Expected: FAIL — module `@/lib/sends/providers/registry` not found.

- [ ] **Step 3: Create `lib/sends/providers/types.ts`**

```ts
// The provider contract. SendSmsResult is the existing normalized send result;
// re-export it from the raw TextHub client to avoid a breaking move (G2).
export type { SendSmsResult } from "@/lib/sends/texthub";

export type NormalizedSendParams = {
  apiKey: string;
  text: string;
  recipientE164: string;      // drain speaks E.164; adapter converts inward
  senderNumber: string | null; // provider_phone (Ahoi needs it; TextHub ignores)
  leadId?: string | null;
};

export type RawWebhook = {
  query: Record<string, string>;
  body: string;
  headers: Record<string, string>;
};

export type DlrEvent = {
  providerUuid: string;
  sendStatus: string;
  status: string;
  smppStatus: string | null;
  smppCode: string | null;
  error: string | null;
};

export type InboundEvent = {
  source: string;
  destination: string;
  message: string;
  type: string;
  cost: string | null;
};

import type { SendSmsResult } from "@/lib/sends/texthub";
export interface SmsProviderAdapter {
  key: "texthub" | "ahoi";
  send(p: NormalizedSendParams): Promise<SendSmsResult>;
  buildRedactedRequest(p: NormalizedSendParams): string;
  toProviderRecipient(e164: string): string;
  parseDlr(raw: RawWebhook): DlrEvent | null;
  parseInbound(raw: RawWebhook): InboundEvent | null;
}
```

- [ ] **Step 4: Create `lib/sends/providers/texthub.ts` (adapter wrapper)**

```ts
// TextHub adapter — wraps the unchanged raw client (lib/sends/texthub.ts).
import {
  buildSendUrl,
  sendSms as rawSendSms,
} from "@/lib/sends/texthub";
import type {
  DlrEvent, InboundEvent, NormalizedSendParams, RawWebhook,
  SendSmsResult, SmsProviderAdapter,
} from "./types";

export const texthubAdapter: SmsProviderAdapter = {
  key: "texthub",
  // TextHub's number is international format already — identity conversion.
  toProviderRecipient(e164: string): string {
    return e164;
  },
  async send(p: NormalizedSendParams): Promise<SendSmsResult> {
    return rawSendSms({
      apiKey: p.apiKey,
      text: p.text,
      number: this.toProviderRecipient(p.recipientE164),
      leadId: p.leadId,
    });
  },
  buildRedactedRequest(p: NormalizedSendParams): string {
    return buildSendUrl({
      apiKey: p.apiKey,
      text: p.text,
      number: this.toProviderRecipient(p.recipientE164),
      leadId: p.leadId,
    });
  },
  // TextHub DLR is not polled/used (project §12) — no-ops.
  parseDlr(_raw: RawWebhook): DlrEvent | null { return null; },
  parseInbound(_raw: RawWebhook): InboundEvent | null { return null; },
};
```

- [ ] **Step 5: Create `lib/sends/providers/registry.ts`**

```ts
import type { SmsProviderAdapter } from "./types";
import { texthubAdapter } from "./texthub";
import { ahoiAdapter } from "./ahoi";

export class UnknownProviderError extends Error {
  constructor(public readonly key: string) {
    super(`Unknown SMS provider key: ${key}`);
    this.name = "UnknownProviderError";
  }
}

const ADAPTERS: Record<string, SmsProviderAdapter> = {
  texthub: texthubAdapter,
  ahoi: ahoiAdapter,
};

export function getAdapter(key: string): SmsProviderAdapter {
  const a = ADAPTERS[key];
  if (!a) throw new UnknownProviderError(key);
  return a;
}
```

Note: registry imports `./ahoi` — create the Ahoi skeleton in Task 2 first if executing strictly TDD; the registry test depends on it. (Tasks 1 and 2 may be committed together; the registry test in Step 1 exercises both.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx scripts/test-ahoi-registry.ts` (after Task 2's `ahoi.ts` exists)
Expected: PASS — `ALL PASS`, exit 0.

- [ ] **Step 7: Commit**

```bash
git add lib/sends/providers/types.ts lib/sends/providers/texthub.ts lib/sends/providers/registry.ts lib/sends/providers/ahoi.ts scripts/test-ahoi-registry.ts
git commit -m "feat(ahoi): provider adapter interface + registry + texthub/ahoi adapters"
```

---

## Task 2: Ahoi adapter skeleton (recipient conversion real)

**Files:**
- Create: `lib/sends/providers/ahoi.ts`
- Test: `scripts/test-ahoi-recipient.ts`

**Interfaces:**
- Consumes: `SmsProviderAdapter`, `NormalizedSendParams`, `RawWebhook` from `./types`.
- Produces: `export const ahoiAdapter: SmsProviderAdapter` with a real `toProviderRecipient` (E.164 `+1XXXXXXXXXX` → 10-digit `XXXXXXXXXX`); `send`/`buildRedactedRequest`/`parseDlr`/`parseInbound` throw/stub until Sections 2–3.

- [ ] **Step 1: Write the failing test** — `scripts/test-ahoi-recipient.ts`

```ts
// Ahoi recipient conversion: E.164 US -> bare 10-digit.
// Run: npx tsx scripts/test-ahoi-recipient.ts
import { ahoiAdapter } from "@/lib/sends/providers/ahoi";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

check("+1 stripped to 10-digit", ahoiAdapter.toProviderRecipient("+15642155963") === "5642155963");
check("bare 11-digit 1XXXXXXXXXX -> 10", ahoiAdapter.toProviderRecipient("15642155963") === "5642155963");
check("already 10-digit unchanged", ahoiAdapter.toProviderRecipient("5642155963") === "5642155963");
check("send() not implemented in Section 1", (() => {
  try { void ahoiAdapter.send; return typeof ahoiAdapter.send === "function"; } catch { return false; }
})());

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-ahoi-recipient.ts`
Expected: FAIL — module `@/lib/sends/providers/ahoi` not found.

- [ ] **Step 3: Create `lib/sends/providers/ahoi.ts`**

```ts
// Ahoi (api19/CallAPI) adapter. Section 1 = skeleton: recipient conversion is
// real; send/parse are implemented in Sections 2–3.
import type {
  DlrEvent, InboundEvent, NormalizedSendParams, RawWebhook,
  SendSmsResult, SmsProviderAdapter,
} from "./types";

// E.164 US (+1XXXXXXXXXX) or 1XXXXXXXXXX -> bare 10-digit XXXXXXXXXX.
export function toAhoiRecipient(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits; // already 10-digit (or leave as-is for non-US, handled later)
}

export const ahoiAdapter: SmsProviderAdapter = {
  key: "ahoi",
  toProviderRecipient: toAhoiRecipient,
  async send(_p: NormalizedSendParams): Promise<SendSmsResult> {
    throw new Error("ahoi.send not implemented until Section 2");
  },
  buildRedactedRequest(_p: NormalizedSendParams): string {
    throw new Error("ahoi.buildRedactedRequest not implemented until Section 2");
  },
  parseDlr(_raw: RawWebhook): DlrEvent | null {
    throw new Error("ahoi.parseDlr not implemented until Section 3");
  },
  parseInbound(_raw: RawWebhook): InboundEvent | null {
    throw new Error("ahoi.parseInbound not implemented until Section 3");
  },
};
```

- [ ] **Step 4: Run both tests to verify they pass**

Run: `npx tsx scripts/test-ahoi-recipient.ts && npx tsx scripts/test-ahoi-registry.ts`
Expected: PASS both — `ALL PASS`, exit 0.

- [ ] **Step 5: Commit** (folded with Task 1's commit if executed together)

```bash
git add lib/sends/providers/ahoi.ts scripts/test-ahoi-recipient.ts
git commit -m "feat(ahoi): ahoi adapter skeleton with 10-digit recipient conversion"
```

---

## Task 3: Drain integration through the registry (TextHub unchanged)

**Files:**
- Modify: `lib/sends/drain.ts` — imports (line 22), the `Sender` default resolution, the send call (line ~372), the redaction call (line ~428).
- Test: `scripts/test-drain-adapter-seam.ts`

**Interfaces:**
- Consumes: `getAdapter`, `UnknownProviderError` (Task 1); `NormalizedSendParams` (Task 1).
- Produces: drain resolves the adapter from the stage's provider key; `DrainRefusal` gains `"unknown_provider"`; unknown key → refusal, not throw.

- [ ] **Step 1: Add the provider text key to the stage-load (CONFIRMED trivial)**

CONFIRMED (read-only): the stage-load at `lib/sends/drain.ts:165-179` already `LEFT JOIN sms_providers p ON p.id = s.sms_provider_id`, so the text key `p.sms_provider_id` is available in the join — just not selected. Terminology: `campaign_stages.sms_provider_id` is the integer FK (selected `AS provider_id`); `sms_providers.sms_provider_id` (alias `p`) is the text key ("texthub"/"ahoi") this plan calls `provider_key`.

Change 1 — add to the SELECT (line ~165, alongside `s.sms_provider_id AS provider_id`):
```sql
    p.sms_provider_id AS provider_key,
```
Change 2 — add to the result row type (the interface at ~183-186 with `provider_id: number | null`):
```ts
    provider_key: string | null;
```
Then Step 3's `stage.provider_key` (a `string | null`) is in scope for the resolver. Trivial (~2 lines, no new join).

- [ ] **Step 2: Write the failing test** — `scripts/test-drain-adapter-seam.ts`

```ts
// The drain resolves the send function via the provider registry, and an
// unknown provider key yields a clean refusal rather than a throw.
// Run: npx tsx scripts/test-drain-adapter-seam.ts
import { getAdapter, UnknownProviderError } from "@/lib/sends/providers/registry";
import { texthubAdapter } from "@/lib/sends/providers/texthub";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

// resolveSenderForStage(providerKey, injected?) mirrors the drain's resolution:
// injected fake wins (test seam), else the registry adapter's send; unknown key
// throws UnknownProviderError which the drain maps to a refusal.
import { resolveSenderForStage } from "@/lib/sends/drain";

const injected = async () => ({ ok: true } as never);
check("injected sender wins", resolveSenderForStage("texthub", injected) === injected);
check("texthub resolves to adapter.send", typeof resolveSenderForStage("texthub") === "function");

let threw: unknown = null;
try { resolveSenderForStage("bogus"); } catch (e) { threw = e; }
check("unknown key throws UnknownProviderError (drain maps to refusal)", threw instanceof UnknownProviderError);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx scripts/test-drain-adapter-seam.ts`
Expected: FAIL — `resolveSenderForStage` not exported from `@/lib/sends/drain`.

- [ ] **Step 4: Add `unknown_provider` to the refusal enum**

In `lib/sends/drain.ts`, extend `DrainRefusal` (line ~62):

```ts
  | "no_provider"
  | "unknown_provider" // provider row's sms_provider_id has no registered adapter (G3)
  | "no_credentials";
```

- [ ] **Step 5: Add the pure resolver + wire the send/redaction calls**

In `lib/sends/drain.ts`, replace the direct TextHub import (line 22) and add the resolver:

```ts
// was: import { buildSendUrl, sendSms as realSendSms, type SendSmsResult } from "@/lib/sends/texthub";
import type { SendSmsResult } from "@/lib/sends/texthub";
import { getAdapter } from "@/lib/sends/providers/registry";
import type { NormalizedSendParams } from "@/lib/sends/providers/types";

// Resolve the send function for a stage's provider. Injected fake (verify-drain)
// wins for determinism; otherwise the registry adapter's bound send. Throws
// UnknownProviderError for an unregistered key — the caller maps it to the
// `unknown_provider` refusal (G3: never a raw throw out of the drain run).
export function resolveSenderForStage(providerKey: string, injected?: Sender): Sender {
  if (injected) return injected;
  const adapter = getAdapter(providerKey);
  return ({ apiKey, text, number, leadId }) =>
    adapter.send({ apiKey, text, recipientE164: number, senderNumber: null, leadId });
}
```

At the send-loop setup (where `const sendSms = opts.sendSms ?? realSendSms` was), resolve via the stage's provider key inside a try/catch that returns the `unknown_provider` refusal. `stage.provider_key` comes from Step 1; guard the null case (a stage with a provider row but somehow no key) as `unknown_provider` too:

```ts
let sendSms: Sender;
try {
  sendSms = resolveSenderForStage(stage.provider_key ?? "", opts.sendSms);
} catch (e) {
  if (e instanceof UnknownProviderError) return { ...EMPTY, ok: false, reason: "unknown_provider" };
  throw e;
}
```

And the redaction call uses the same key: `getAdapter(stage.provider_key ?? "")`.

Replace the redaction call (line ~428) `buildSendUrl({...})` with the adapter's redactor:

```ts
const requestRedacted = getAdapter(providerKey).buildRedactedRequest({
  apiKey: `redacted_${keyLast4}`, text: c.rendered_text,
  recipientE164: c.phone, senderNumber: null, leadId: c.lead_id,
});
```

(Import `UnknownProviderError` from the registry and `EMPTY` is the existing empty-result constant at line ~107.)

- [ ] **Step 6: Run the drain-seam test + the existing drain verifier to prove TextHub unchanged (G2)**

Run: `npx tsx scripts/test-drain-adapter-seam.ts && npx tsx scripts/verify-drain.ts`
Expected: PASS both. `verify-drain` exercises the injected-`Sender` path + suppressed-status handling; green ⇒ TextHub suppressed/filtered semantics are unchanged.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (confirms no other importer broke on the `drain.ts` import change).

- [ ] **Step 8: Commit**

```bash
git add lib/sends/drain.ts scripts/test-drain-adapter-seam.ts
git commit -m "feat(ahoi): resolve drain send path via provider registry; unknown_provider refusal"
```

---

## Task 4: Seed the Ahoi provider, number, and credential

**Files:**
- Create: `db/migrations/0107_seed_ahoi_provider.sql` (the provider row — no secrets)
- Create: `scripts/seed-ahoi-number-credential.ts` (number + credential; reads `AHOI_API_TOKEN`)
- Test: `scripts/test-ahoi-seed.ts`
- Update: `db/migrations/meta/_journal.json` + snapshot (hand-authored migration convention)

**Interfaces:**
- Consumes: `AHOI_API_TOKEN`, `AHOI_API_BASE_URL` from env; the seeded provider's `id`.
- Produces: an `sms_providers` row with `sms_provider_id='ahoi'`; one `provider_phones` row (approved number, 10-digit stored E.164 as `+1…`); one provider-default `provider_credentials` row.

- [ ] **Step 1: Write the failing test** — `scripts/test-ahoi-seed.ts`

```ts
// Verifies the Ahoi provider/number/credential seed is present + idempotent.
// Run: npx tsx scripts/test-ahoi-seed.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const url = process.env.DATABASE_URL!;
const sql = postgres(url, { prepare: false, max: 1 });
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  const prov = await sql`SELECT id, supports_api_send FROM sms_providers WHERE sms_provider_id = 'ahoi'`;
  check("ahoi provider row exists", prov.length === 1);
  check("supports_api_send = true", prov[0]?.supports_api_send === true);
  const cred = await sql`SELECT 1 FROM provider_credentials WHERE provider_id = ${prov[0]?.id} AND brand_id IS NULL`;
  check("provider-default credential exists", cred.length === 1);
  const ph = await sql`SELECT 1 FROM provider_phones WHERE provider_id = ${prov[0]?.id}`;
  check("at least one provider_phone", ph.length >= 1);
  await sql.end();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-ahoi-seed.ts`
Expected: FAIL — `ahoi provider row exists` ✗ (not seeded yet).

- [ ] **Step 3: Hand-author `db/migrations/0107_seed_ahoi_provider.sql`**

```sql
-- Seed the Ahoi SMS provider row (idempotent, additive). Number + credential
-- are seeded by scripts/seed-ahoi-number-credential.ts (they carry env secrets).
-- Uses the single-org model: attach to the one organizations row.
INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send, status)
SELECT 'ahoi', o.id, 'Ahoi', true, 'active'
FROM organizations o
ON CONFLICT (sms_provider_id) DO NOTHING;
```

Then follow the hand-authored-migration procedure: clone the latest snapshot forward and add the `_journal.json` entry (see `scripts/verify-migration-integrity.ts` and CLAUDE.md §"Migrations are hand-authored"). Confirm the next index is `0107` (check `db/migrations/meta/_journal.json` for the current max).

- [ ] **Step 4: Write `scripts/seed-ahoi-number-credential.ts`**

```ts
// Idempotent seed of the approved Ahoi sending number + provider-default
// credential. Reads AHOI_API_TOKEN from env. Run AFTER migration 0107 applies.
// Run: npx tsx scripts/seed-ahoi-number-credential.ts <approved-10-digit-number>
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const token = process.env.AHOI_API_TOKEN;
if (!token) throw new Error("AHOI_API_TOKEN not set");
const num10 = process.argv[2];
if (!/^\d{10}$/.test(num10 ?? "")) throw new Error("pass a 10-digit number, e.g. 3158359592");

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
async function main() {
  const [prov] = await sql`SELECT id, org_id FROM sms_providers WHERE sms_provider_id = 'ahoi'`;
  if (!prov) throw new Error("Ahoi provider row missing — apply migration 0107 first");
  const e164 = `+1${num10}`;
  await sql`
    INSERT INTO provider_phones (org_id, provider_id, phone_number, number_type, status)
    VALUES (${prov.org_id}, ${prov.id}, ${e164}, '10dlc', 'active')
    ON CONFLICT (org_id, phone_number) DO NOTHING`;
  await sql`
    INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
    VALUES (${prov.org_id}, ${prov.id}, NULL, ${token})
    ON CONFLICT (provider_id, brand_id) DO UPDATE SET api_key = EXCLUDED.api_key, updated_at = now()`;
  await sql.end();
  console.log(`seeded Ahoi number ${e164} + provider-default credential`);
}
main();
```

- [ ] **Step 5: Apply the migration + seed, then verify integrity**

```bash
npm run db:migrate
npx tsx scripts/verify-migration-integrity.ts
npx tsx scripts/seed-ahoi-number-credential.ts 3158359592   # the approved number
```
Expected: migrate applies 0107; integrity chain all-green; seed prints confirmation. (Uses the shared prod DB — additive + idempotent, safe to re-run.)

- [ ] **Step 6: Run the seed test to verify it passes**

Run: `npx tsx scripts/test-ahoi-seed.ts`
Expected: PASS — `ALL PASS`, exit 0.

- [ ] **Step 7: Update docs + commit**

Update `docs/03-data-model.md` (note the Ahoi provider seed — no schema change, a new provider row), and append to `docs/CHANGELOG.md`: `2026-07-14 — Ahoi provider seeded (migration 0107) — docs/03-data-model.md`.

```bash
git add db/migrations/0107_seed_ahoi_provider.sql db/migrations/meta/ scripts/seed-ahoi-number-credential.ts scripts/test-ahoi-seed.ts docs/03-data-model.md docs/CHANGELOG.md
git commit -m "feat(ahoi): seed Ahoi provider row (mig 0107) + number/credential seed script"
```

---

## Section 1 Checkpoint

Stop here and bring back for review before Section 2 (send path). Deliverables:
- Provider adapter seam live (`lib/sends/providers/`), registry resolves `texthub`/`ahoi`, unknown → clean refusal.
- Drain routes through the registry; TextHub send/suppression path proven unchanged (`verify-drain` green).
- Ahoi provider/number/credential seeded; `SEND_ENABLED` still off; no Ahoi send code yet.

---

## Self-Review

**Spec coverage (Section 1 scope):** adapter interface + registry (Task 1 ✓), TextHub adapter wrapper unchanged behavior/G2 (Task 1+3 ✓), Ahoi skeleton + recipient conversion (Task 2 ✓), drain integration + G3 unknown-key refusal (Task 3 ✓), data-model seed reusing provider_* tables (Task 4 ✓). G1 (webhook auth) is Section 3 — correctly absent here. Segment policy / DLR / opt-out are later sections — out of this plan by design.

**Placeholder scan:** Task 3 Step 1 is a read-to-confirm (`providerKey` location), not a placeholder — the dependent code is fully written assuming the confirmed variable. No TBDs. All test code and implementation code are complete.

**Type consistency:** `NormalizedSendParams` fields (`apiKey/text/recipientE164/senderNumber/leadId`) are identical across `types.ts`, both adapters, and the drain resolver. `getAdapter`/`UnknownProviderError`/`ahoiAdapter`/`texthubAdapter`/`toAhoiRecipient` names match across tasks. `SendSmsResult` is re-exported once (types.ts) from the raw client.

**Open risk (RESOLVED):** Task 3's dependency on the stage's provider text key is confirmed trivial — `drain.ts:178` already joins `sms_providers p`; Step 1 adds `p.sms_provider_id AS provider_key` (~2 lines, no new join). Single-org confirmed (`organizations` count = 1), so the seed migration creates exactly one Ahoi row.
