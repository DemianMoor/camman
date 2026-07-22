# TextHub Sender Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send TextHub messages from the number selected on the stage (via the new `sender` API parameter), add a campaign-level default that prefills new stages, and block any API-send stage that has no sending number.

**Architecture:** The send pipeline already resolves the stage's `provider_phone_id` to `senderNumber` and passes it to the provider adapter (Ahoi consumes it; TextHub discards it). We make the TextHub adapter emit `sender` (the phone as national digits) and refuse when it is absent — mirroring Ahoi. We generalize the existing kickoff `no_sender_number` gate (currently Ahoi-only) to all API-send providers and add the matching read-only preflight check. A new nullable `campaigns.default_provider_phone_id` column drives a prefill-only convenience in the campaign + stage forms; send-time resolution stays stage-only.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Drizzle ORM, Zod, react-hook-form, Postgres (Supabase). Tests are plain `tsx` scripts with a hand-rolled `check()` harness (no test framework).

## Global Constraints

- **No `libphonenumber-js` in the send/test path.** It throws under `tsx`; the sender transform must be hand-rolled (mirrors `toAhoiRecipient`). Verified by `verify-drain.ts` / `test-texthub-send.ts` running under `tsx`.
- **`sender` value = phone number without country code:** 10 digits for 10DLC/TFN (`+19175551234` → `9175551234`); short codes (5–6 digits) unchanged. US-only assumption.
- **Multi-tenancy:** every new query filters by `org_id`. FK inputs re-verified against the caller's org before insert/update (RLS is defense-in-depth only).
- **Migrations are hand-authored** (`db:generate` is blocked). Write the SQL, clone the prior snapshot forward, add the journal entry, then `npm run db:migrate` against the shared prod `DATABASE_URL`, then `npx tsx scripts/verify-migration-integrity.ts`. Next migration index = **0115**.
- **Provider keys** are short DB codes: `txh` and `txh2` both map to `texthubAdapter`; `ahi` → `ahoiAdapter` (`lib/sends/providers/registry.ts`).
- **Never** commit secrets or log the raw `api_key`; redacted request strings carry a placeholder only.
- **Docs are part of "done"** — update the docs listed in the final task and append a `CHANGELOG.md` line.
- Test-run convention: `npx tsx scripts/<name>.ts` (exit 0 = pass).

---

## Task 1: TextHub `sender` transform + URL param (pure client)

**Files:**
- Modify: `lib/sends/texthub.ts`
- Test: `scripts/test-texthub-send.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `toTexthubSender(e164: string): string` — national digits (`"+19175551234"` → `"9175551234"`; `"12345"` → `"12345"`).
  - `SendSmsParams` gains optional `sender?: string | null`.
  - `buildSendUrl` sets the `sender` query param only when truthy.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-texthub-send.ts`:

```ts
// TextHub sender param + national-digit transform. Pure (no network for the
// URL-builder assertions). Mirrors scripts/test-ahoi-send.ts's check() harness.
// Run: npx tsx scripts/test-texthub-send.ts
import { buildSendUrl, toTexthubSender } from "@/lib/sends/texthub";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

function main() {
  // Transform: 10DLC/TFN E.164 -> 10 national digits.
  check("toTexthubSender strips +1", toTexthubSender("+19175551234") === "9175551234");
  check("toTexthubSender strips bare leading 1", toTexthubSender("19175551234") === "9175551234");
  // Transform: short code passes through unchanged.
  check("toTexthubSender keeps 5-digit short code", toTexthubSender("12345") === "12345");
  check("toTexthubSender keeps 6-digit short code", toTexthubSender("123456") === "123456");

  // buildSendUrl includes sender when set.
  const withSender = buildSendUrl({
    apiKey: "k",
    text: "hi",
    number: "+15642155963",
    sender: toTexthubSender("+19175551234"),
  });
  check("URL carries sender=9175551234", withSender.includes("sender=9175551234"), withSender);

  // buildSendUrl omits sender when absent (still a valid URL).
  const noSender = buildSendUrl({ apiKey: "k", text: "hi", number: "+15642155963" });
  check("URL omits sender when unset", !noSender.includes("sender="), noSender);
  // Invariants preserved.
  check("URL never sets long_url", !withSender.includes("long_url="));
  check("URL never sets group", !withSender.includes("group="));

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/test-texthub-send.ts`
Expected: FAIL — `toTexthubSender` is not exported and `buildSendUrl` ignores `sender` (import error or `sender=` assertions fail).

- [ ] **Step 3: Implement the transform + param in `lib/sends/texthub.ts`**

Add the `sender` field to `SendSmsParams` (just below `leadId`):

```ts
  leadId?: string | null;
  // Send-from number as TextHub wants it: national digits, no country code
  // (10 digits for 10DLC/TFN, short code as-is). Optional — the adapter refuses
  // when it can't supply one, so in practice buildSendUrl always receives it.
  sender?: string | null;
  timeoutMs?: number;
```

Add the helper above `buildSendUrl`:

```ts
// E.164 US number -> TextHub `sender` (national digits, no country code):
// "+19175551234" -> "9175551234". Short codes (5-6 digits, no country code) pass
// through unchanged. Hand-rolled on purpose — libphonenumber throws under tsx
// (see lib/sends/providers/ahoi.ts toAhoiRecipient); US-only assumption.
export function toTexthubSender(e164: string): string {
  const digits = (e164 ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}
```

In `buildSendUrl`, add the conditional set after the `lead_id` line:

```ts
  if (params.leadId) url.searchParams.set("lead_id", params.leadId);
  if (params.sender) url.searchParams.set("sender", params.sender);
  // Intentionally never set `long_url` or `group`.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/test-texthub-send.ts`
Expected: PASS — `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add lib/sends/texthub.ts scripts/test-texthub-send.ts
git commit -m "feat(sends): TextHub sender param + national-digit transform"
```

---

## Task 2: TextHub adapter — emit `sender`, refuse on null

**Files:**
- Modify: `lib/sends/providers/texthub.ts`
- Test: `scripts/test-texthub-send.ts` (extend)

**Interfaces:**
- Consumes: `toTexthubSender`, `buildSendUrl`, `sendSms` from `lib/sends/texthub` (Task 1); `NormalizedSendParams.senderNumber` (already exists).
- Produces: `texthubAdapter.send` / `.buildRedactedRequest` now carry `sender`; `send` returns `ok:false` (no network) when `senderNumber` is null.

- [ ] **Step 1: Extend the test (append inside `main`, before the summary)**

First make `main` async — change `function main() {` to `async function main() {` and `main();` at the bottom to `void main();`. Then append:

```ts
  // Adapter: refuse-on-null (mirrors Ahoi) — ok:false, no network call.
  let fetchCalled = false;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as unknown as typeof fetch;
  const { texthubAdapter } = await import("@/lib/sends/providers/texthub");
  const noSender = await texthubAdapter.send({
    apiKey: "k", text: "hi", recipientE164: "+15642155963", senderNumber: null,
  });
  check("no senderNumber -> ok:false with no network call", noSender.ok === false && !fetchCalled);
  check("no senderNumber -> status 0 (our config issue)", noSender.status === 0);

  // Adapter: with a sender, the redacted request carries sender + placeholder key.
  const redacted = texthubAdapter.buildRedactedRequest({
    apiKey: "redacted_1234", text: "hi", recipientE164: "+15642155963",
    senderNumber: "+19175551234",
  });
  check("redacted carries sender=9175551234", redacted.includes("sender=9175551234"), redacted);
  check("redacted carries the placeholder key", redacted.includes("redacted_1234"));
```

- [ ] **Step 2: Run the test to verify the new cases fail**

Run: `npx tsx scripts/test-texthub-send.ts`
Expected: FAIL — the adapter currently ignores `senderNumber` (calls fetch, no `sender=` in redaction).

- [ ] **Step 3: Rewrite `lib/sends/providers/texthub.ts`**

```ts
// TextHub adapter — wraps the unchanged raw client (lib/sends/texthub.ts).
import {
  buildSendUrl,
  sendSms as rawSendSms,
  toTexthubSender,
} from "@/lib/sends/texthub";
import type {
  DlrEvent, InboundEvent, NormalizedSendParams, RawWebhook,
  SendSmsResult, SmsProviderAdapter,
} from "./types";

export const texthubAdapter: SmsProviderAdapter = {
  key: "txh",
  // TextHub's number is international format already — identity conversion.
  toProviderRecipient(e164: string): string {
    return e164;
  },
  async send(p: NormalizedSendParams): Promise<SendSmsResult> {
    if (!p.senderNumber) {
      // The org chose to block rather than fall back to TextHub's account
      // default sender. A stage with no provider_phone_id can't send. Refuse
      // cleanly (never throw, never post) — OUR misconfiguration, so it
      // classifies as mine_transport (status 0, not timed out). Mirrors Ahoi.
      return {
        ok: false,
        messageId: null,
        response: null,
        providerStatus: null,
        suppressed: false,
        rawBody: null,
        error: "texthub: no sender number configured for this stage",
        status: 0,
        timedOut: false,
      };
    }
    return rawSendSms({
      apiKey: p.apiKey,
      text: p.text,
      number: this.toProviderRecipient(p.recipientE164),
      sender: toTexthubSender(p.senderNumber),
      leadId: p.leadId,
    });
  },
  buildRedactedRequest(p: NormalizedSendParams): string {
    return buildSendUrl({
      apiKey: p.apiKey,
      text: p.text,
      number: this.toProviderRecipient(p.recipientE164),
      sender: p.senderNumber ? toTexthubSender(p.senderNumber) : undefined,
      leadId: p.leadId,
    });
  },
  // TextHub DLR is not polled/used (project §12) — no-ops.
  parseDlr(_raw: RawWebhook): DlrEvent | null { return null; },
  parseInbound(_raw: RawWebhook): InboundEvent | null { return null; },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/test-texthub-send.ts`
Expected: PASS — `ALL PASS`.

- [ ] **Step 5: Regression — run the drain verifier**

Run: `npx tsx scripts/verify-drain.ts`
Expected: ends with `verify-drain OK.` (the injected fakes ignore `senderNumber`, so the adapter change can't regress them).

- [ ] **Step 6: Commit**

```bash
git add lib/sends/providers/texthub.ts scripts/test-texthub-send.ts
git commit -m "feat(sends): TextHub adapter emits sender, refuses on null (mirrors Ahoi)"
```

---

## Task 3: Generalize the kickoff `no_sender_number` gate to all API providers

**Files:**
- Modify: `lib/sends/kickoff.ts:227`

**Interfaces:**
- Consumes: existing `KickoffRefusal` value `no_sender_number` and `KICKOFF_REFUSAL` message (both already defined).
- Produces: kickoff now refuses `no_sender_number` for **any** API-send stage (txh/txh2/ahi/future) whose `provider_phone_id` is null.

- [ ] **Step 1: Read the current guard**

Run: `npx tsx -e "0" ` is not needed — just open `lib/sends/kickoff.ts` around line 219-229 and confirm the guard sits *after* the `supports_api_send` gate (line 219 returns `provider_not_api_capable` when the provider can't API-send). This ordering guarantees the generalized check only ever fires for API-capable providers.

- [ ] **Step 2: Replace the Ahoi-only condition**

Replace:

```ts
    // No-sender-number guard (Section 3 Task 8; carried from Section 2's
    // final review). Only Ahoi needs a provider_phone_id — see the design
    // note in the Section 3 plan for why this is a plain key check rather
    // than a new adapter capability flag.
    if (provider[0].provider_key === "ahi" && row.provider_phone_id == null) {
      return { ok: false, reason: "no_sender_number" };
    }
```

with:

```ts
    // No-sender-number guard. Every API-send provider now selects its send-from
    // number via the stage's provider_phone_id: Ahoi as the `source`, TextHub as
    // the `sender` param (2026-07-22). This sits after the supports_api_send gate
    // above, so it only fires for API-capable providers. Blocking here (rather
    // than falling back to a provider account default) is the deliberate product
    // rule — a deliberate sender is required.
    if (row.provider_phone_id == null) {
      return { ok: false, reason: "no_sender_number" };
    }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Regression — drain verifier still green**

Run: `npx tsx scripts/verify-drain.ts`
Expected: `verify-drain OK.` (kickoff is a separate path; this just confirms nothing shared broke).

- [ ] **Step 5: Commit**

```bash
git add lib/sends/kickoff.ts
git commit -m "feat(sends): require a sending number for ALL API-send stages at kickoff"
```

---

## Task 4: Add the sender check to the read-only preflight checklist

**Files:**
- Modify: `lib/sends/preflight.ts`

**Interfaces:**
- Consumes: `MainRow.provider_phone_id` (already selected by the preflight query).
- Produces: `PreflightBlocker` gains `"no_sender_number"`; the tracked branch emits a `sender` check.

- [ ] **Step 1: Extend the `PreflightBlocker` union**

Replace:

```ts
export type PreflightBlocker =
  | "no_creative"
  | "no_recipients"
  | "stage_not_ready" // tracking ids not generated yet
  | "no_provider"
  | "provider_not_api_capable"
  | "no_credentials"
  | "no_short_domain";
```

with (add the new member):

```ts
export type PreflightBlocker =
  | "no_creative"
  | "no_recipients"
  | "stage_not_ready" // tracking ids not generated yet
  | "no_provider"
  | "provider_not_api_capable"
  | "no_sender_number" // API-send stage has no provider_phone_id assigned
  | "no_credentials"
  | "no_short_domain";
```

- [ ] **Step 2: Emit the check in the tracked branch**

In the `if (mode === "tracked") { ... }` block, add the sender check immediately after the `provider_api` check (right before the `hasCred` block):

```ts
    add(
      "provider_api",
      hasProvider && row.supports_api_send === true,
      "Provider supports API send",
      "provider_not_api_capable",
    );
    add(
      "sender",
      row.provider_phone_id != null,
      "Sending number assigned",
      "no_sender_number",
    );
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. (`PreflightResult.blockers` is `PreflightBlocker[]`; the new member is covered.)

- [ ] **Step 4: Commit**

```bash
git add lib/sends/preflight.ts
git commit -m "feat(sends): preflight checklist flags a missing sending number"
```

---

## Task 5: Migration 0115 — `campaigns.default_provider_phone_id`

**Files:**
- Create: `db/migrations/0115_campaign_default_sender.sql`
- Create: `db/migrations/meta/0115_snapshot.json` (clone of `0114_snapshot.json` + the new column)
- Modify: `db/migrations/meta/_journal.json`
- Modify: `db/schema.ts` (campaigns table)

**Interfaces:**
- Produces: `campaigns.default_provider_phone_id integer NULL REFERENCES provider_phones(id) ON DELETE SET NULL`, and the Drizzle column `campaigns.default_provider_phone_id`.

- [ ] **Step 1: Write the migration SQL**

Create `db/migrations/0115_campaign_default_sender.sql`:

```sql
-- Campaign-level default send-from number. Prefill convenience only: when a new
-- stage is created it inherits this as its provider_phone_id (operator can
-- override). Send-time resolution stays stage-only. Nullable; ON DELETE SET NULL
-- so archiving/removing a phone doesn't block campaign edits. Additive +
-- backward-compatible — existing rows default to NULL (no default sender).
ALTER TABLE "campaigns"
  ADD COLUMN "default_provider_phone_id" integer
  REFERENCES "provider_phones"("id") ON DELETE SET NULL;
```

- [ ] **Step 2: Add the Drizzle column to `db/schema.ts`**

In the `campaigns` table, after the `link_mode` column (before `archived_at`), add:

```ts
    // Campaign-level default send-from number (migration 0115). PREFILL ONLY:
    // a new stage inherits this as its provider_phone_id; send-time resolution
    // stays stage-only. NULL = no default. See docs/superpowers/specs/
    // 2026-07-22-texthub-sender-id-design.md.
    default_provider_phone_id: integer("default_provider_phone_id").references(
      () => provider_phones.id,
      { onDelete: "set null" },
    ),
```

(`integer` and `provider_phones` are already imported/defined in `db/schema.ts`.)

- [ ] **Step 3: Clone the snapshot forward**

Copy `db/migrations/meta/0114_snapshot.json` to `db/migrations/meta/0115_snapshot.json`, then add the new column to the `campaigns` table's `columns` object inside the copy (match the shape of a nullable integer FK column — e.g. copy the existing `routing_type_id` column entry and adjust `name`/`columnType`/`notNull:false`, and add a matching entry under the table's `foreignKeys`). Bump the snapshot's top-level `id`/`prevId` to chain from 0114. If unsure of the exact JSON shape, follow the process in the project memory "Migrations are hand-authored" — clone forward and hand-edit.

- [ ] **Step 4: Add the journal entry**

In `db/migrations/meta/_journal.json`, append after the `0114` entry (increment `idx` to 115, use the next `when` timestamp `1786320000000`):

```json
    ,
    { "idx": 115, "version": "7", "when": 1786320000000, "tag": "0115_campaign_default_sender", "breakpoints": true }
```

- [ ] **Step 5: Apply the migration to the database**

Run: `npm run db:migrate`
Expected: `0115_campaign_default_sender` applies without error. (This hits the shared prod `DATABASE_URL` — CLAUDE.md §14.)

- [ ] **Step 6: Verify migration integrity**

Run: `npx tsx scripts/verify-migration-integrity.ts`
Expected: all-green, chain clean (60/60 or current count), no drift.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/0115_campaign_default_sender.sql db/migrations/meta/0115_snapshot.json db/migrations/meta/_journal.json db/schema.ts
git commit -m "feat(db): campaigns.default_provider_phone_id (migration 0115)"
```

---

## Task 6: Org-wide active-phones list endpoint

**Files:**
- Create: `app/api/provider-phones/list/route.ts`

**Interfaces:**
- Produces: `GET /api/provider-phones/list` → `{ data: ActivePhone[] }` where
  `ActivePhone = { id: number; phone_number: string; number_type: string; provider_id: number; provider_name: string; provider_key: string; supports_api_send: boolean }`, active phones for the caller's org across all providers, ordered by provider name then phone number. Gated on `provider_phones.view`.

- [ ] **Step 1: Write the route**

Create `app/api/provider-phones/list/route.ts`:

```ts
import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { provider_phones, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// Org-wide list of ACTIVE provider phones across all providers, labeled by
// provider. Powers the campaign form's "Default send-from number" picker
// (there is no campaign-level provider, so this crosses providers by design).
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_phones.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const rows = await db
    .select({
      id: provider_phones.id,
      phone_number: provider_phones.phone_number,
      number_type: provider_phones.number_type,
      provider_id: sms_providers.id,
      provider_name: sms_providers.name,
      provider_key: sms_providers.sms_provider_id,
      supports_api_send: sms_providers.supports_api_send,
    })
    .from(provider_phones)
    .innerJoin(sms_providers, eq(sms_providers.id, provider_phones.provider_id))
    .where(
      and(
        eq(provider_phones.org_id, orgId),
        eq(provider_phones.status, "active"),
      ),
    )
    .orderBy(asc(sms_providers.name), asc(provider_phones.phone_number));

  return NextResponse.json({ data: rows });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Sanity-check the route compiles/builds**

Run: `npx next build --no-lint` (or the project's usual `npm run build`) and confirm the new route appears without error. If a full build is too slow for this step, `npx tsc --noEmit` from Step 2 is the minimum gate.

- [ ] **Step 4: Commit**

```bash
git add app/api/provider-phones/list/route.ts
git commit -m "feat(api): org-wide active provider-phones list endpoint"
```

---

## Task 7: Accept `default_provider_phone_id` in campaign create/update

**Files:**
- Modify: `lib/validators/campaigns.ts`
- Modify: `app/api/campaigns/route.ts` (POST)
- Modify: `app/api/campaigns/[campaignId]/route.ts` (GET select + PATCH FK-verify)

**Interfaces:**
- Consumes: `campaignCreateSchema` / `campaignUpdateSchema` (extended).
- Produces: create inserts the column; GET returns it; PATCH persists it (via the generic `updates` loop) after FK-verifying org ownership.

- [ ] **Step 1: Add the field to the validator**

In `lib/validators/campaigns.ts`, inside `campaignCreateBaseSchema`, after the `traffic_type_id` field, add:

```ts
  // Campaign-level default send-from number (migration 0115). Prefill only —
  // the send path never reads it. Null clears the default. Ownership re-verified
  // in the route against provider_phones for this org.
  default_provider_phone_id: z.number().int().positive().nullable().optional(),
```

(Both `campaignCreateSchema` and `campaignUpdateSchema` derive from this base, so PATCH picks it up automatically.)

- [ ] **Step 2: Insert the column in the create route**

In `app/api/campaigns/route.ts`, first FK-verify ownership. After the existing `traffic_type_id` ownership block (ends ~line 160), add:

```ts
  if (input.default_provider_phone_id != null) {
    const r = await db
      .select({ id: provider_phones.id })
      .from(provider_phones)
      .where(
        and(
          eq(provider_phones.id, input.default_provider_phone_id),
          eq(provider_phones.org_id, orgId),
        ),
      )
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "default_provider_phone_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "default_provider_phone_id" },
      );
    }
  }
```

Add `provider_phones` to the `@/db/schema` import at the top of the file. Then in the `tx.insert(campaigns).values({ ... })` object, after `link_mode: input.link_mode ?? "manual",` add:

```ts
            default_provider_phone_id: input.default_provider_phone_id ?? null,
```

- [ ] **Step 3: Return + FK-verify the column in `[campaignId]/route.ts`**

In the GET `select({...})`, after `link_mode: campaigns.link_mode,` add:

```ts
      default_provider_phone_id: campaigns.default_provider_phone_id,
```

Add `provider_phones` to the `@/db/schema` import. In `PATCH`, after the contact-group ownership block (~line 324) and before the reassignment gate, add:

```ts
  // Verify org ownership of the default sender phone when present (RLS is
  // defense-in-depth). null is allowed (clears the default).
  if (input.default_provider_phone_id != null) {
    const found = await db
      .select({ id: provider_phones.id })
      .from(provider_phones)
      .where(
        and(
          eq(provider_phones.id, input.default_provider_phone_id),
          eq(provider_phones.org_id, orgId),
        ),
      )
      .limit(1);
    if (!found[0]) {
      return apiError(
        400,
        "default_provider_phone_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "default_provider_phone_id" },
      );
    }
  }
```

(The generic `updates` loop at the bottom of PATCH already writes any non-`undefined`, non-`NON_UPDATABLE` field, so `default_provider_phone_id` persists without further changes.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add lib/validators/campaigns.ts app/api/campaigns/route.ts "app/api/campaigns/[campaignId]/route.ts"
git commit -m "feat(campaigns): accept default_provider_phone_id on create/update"
```

---

## Task 8: Campaign form — "Default send-from number" picker

**Files:**
- Modify: `components/campaigns/campaign-form-state.ts`
- Modify: `components/campaigns/campaign-form-fields.tsx`

**Interfaces:**
- Consumes: `GET /api/provider-phones/list` (Task 6); `campaigns.default_provider_phone_id` on the loaded campaign (Task 7).
- Produces: the form reads/writes `default_provider_phone_id`.

- [ ] **Step 1: Add the form value + type**

In `components/campaigns/campaign-form-state.ts`:
- Add `default_provider_phone_id: number | null;` to the `CampaignFormValues` type (near `routing_type_id`, ~line 46).
- Add an option type near `BrandOption` (~line 14):

```ts
export type ActivePhone = {
  id: number;
  phone_number: string;
  number_type: string;
  provider_id: number;
  provider_name: string;
  provider_key: string;
  supports_api_send: boolean;
};
```

- Add a fetch hook + state alongside the others (~line 117-124):

```ts
  const phonesApi = useApiCall<{ data: ActivePhone[] }>();
  const [activePhones, setActivePhones] = useState<ActivePhone[]>([]);
```

- Add a load effect mirroring the brands/offers loaders (~line 134):

```ts
  useEffect(() => {
    void (async () => {
      const r = await phonesApi.execute("/api/provider-phones/list");
      if (r.ok) setActivePhones(r.data.data);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phonesApi.execute]);
```

- Add to `defaultValues` (~line 185, after `routing_type_id`):

```ts
      default_provider_phone_id: initialValues?.default_provider_phone_id ?? null,
```

- Return `activePhones` from the hook so the fields component can read it (add to the returned object).

- [ ] **Step 2: Render the picker in `campaign-form-fields.tsx`**

Read the file to find where `routing_type_id` / `traffic_type_id` selects render, and add a matching `<FormField name="default_provider_phone_id">` with a shadcn `<Select>`, following the exact pattern already used for the other single-FK selects in that file. Use `state.activePhones` for options; label each item `formatPhoneInternational(p.phone_number)` + a muted `p.provider_name`. Value/`onValueChange` convert `"__none__"` ↔ `null` and string ↔ `Number` (same convention as the stage form's phone picker). Label the field `Default send-from number` with muted help text: `New stages start from this number. Optional; each stage can override.`

Concretely, mirror this shape (adapt imports/props to the file's existing ones):

```tsx
<FormField
  control={form.control}
  name="default_provider_phone_id"
  render={({ field }) => (
    <FormItem>
      <FormLabel>Default send-from number</FormLabel>
      <Select
        value={field.value === null ? "__none__" : String(field.value)}
        onValueChange={(v) => field.onChange(v === "__none__" ? null : Number(v))}
      >
        <FormControl>
          <SelectTrigger>
            <SelectValue placeholder="No default" />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          <SelectItem value="__none__">No default</SelectItem>
          {state.activePhones.map((p) => (
            <SelectItem key={p.id} value={String(p.id)}>
              <span className="font-mono text-xs">
                {formatPhoneInternational(p.phone_number)}
              </span>
              <span className="ml-2 text-xs text-muted-foreground">
                {p.provider_name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        New stages start from this number. Optional; each stage can override.
      </p>
      <FormMessage />
    </FormItem>
  )}
/>
```

Ensure `formatPhoneInternational` is imported from `@/lib/phone-validation` in the fields file (add if missing).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Manual smoke (dev server)**

Run the app (`npm run dev`), open a campaign create + an existing campaign edit, confirm the picker lists active phones (labeled by provider), saves, and reloads the saved value. (No automated UI test in this project.)

- [ ] **Step 5: Commit**

```bash
git add components/campaigns/campaign-form-state.ts components/campaigns/campaign-form-fields.tsx
git commit -m "feat(campaigns): default send-from number picker on the campaign form"
```

---

## Task 9: Stage form — prefill provider + phone from the campaign default

**Files:**
- Modify: `components/campaigns/stage-form.tsx`

**Interfaces:**
- Consumes: the parent campaign's `default_provider_phone_id` and the resolved phone's `provider_id`. The stage form already loads phones per provider and auto-selects a single phone.
- Produces: on **create** (not edit), a new stage's `sms_provider_id` + `provider_phone_id` initialize from the campaign default when the form has no explicit value yet.

- [ ] **Step 1: Determine how the stage form receives campaign context**

Read `components/campaigns/stage-form.tsx` (props/`defaultValues` ~line 300-310, and the create-mode auto-select effect ~line 505-545) and the caller in `app/(protected)/campaigns/[id]/page.tsx` to see whether the campaign's `default_provider_phone_id` (and the phone's provider) is already available to the form. If the page has the campaign object, pass two new optional props to `StageForm`: `defaultProviderPhoneId?: number | null` and `defaultProviderId?: number | null` (resolve the provider by looking the phone up in the same `/api/provider-phones/list` payload, or add `provider_id` to the campaign GET response — prefer the list payload to avoid a schema change). Choose the lookup source that already exists on the page; do not add speculative fetches.

- [ ] **Step 2: Seed create-mode defaults**

In the stage form's `defaultValues` (create mode only, ~line 300-310), initialize:

```ts
    sms_provider_id: initialValues?.sms_provider_id ?? props.defaultProviderId ?? null,
    provider_phone_id: initialValues?.provider_phone_id ?? props.defaultProviderPhoneId ?? null,
```

Guard so this only applies when `!isEdit` (an existing stage keeps its own values). If the existing `defaultValues` already spread `initialValues`, add the `?? props.default…` fallback only on these two keys.

- [ ] **Step 3: Don't let the phone-reload effect clobber the prefill**

The effect at ~line 509-543 clears `provider_phone_id` when it isn't valid for the freshly loaded provider list. Confirm the prefilled phone belongs to the prefilled provider (it does — the default phone's provider is what we seed), so `r.data.data.some((p) => p.id === watchedPhoneId)` stays true and the value survives. No code change expected; verify by reading the effect. If the prefill races the fetch, gate the "clear" branch on `!isEdit && firstLoad` the same way the auto-select-single branch is gated.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Manual smoke**

With a campaign that has a default sender set, click "Add stage" and confirm the provider + phone come pre-selected, and that overriding them still works. On a campaign with no default, the stage form behaves exactly as before.

- [ ] **Step 6: Commit**

```bash
git add components/campaigns/stage-form.tsx "app/(protected)/campaigns/[id]/page.tsx"
git commit -m "feat(campaigns): new stages prefill provider+phone from the campaign default"
```

---

## Task 10: Pre-deploy audit — active stages missing a sender

**Files:**
- Create: `scripts/audit-stages-missing-sender.ts`

**Interfaces:**
- Produces: a read-only report of active-campaign, API-send, tracked stages with `provider_phone_id IS NULL` that the new kickoff block (Task 3) would now refuse.

- [ ] **Step 1: Write the read-only audit script**

Create `scripts/audit-stages-missing-sender.ts`:

```ts
// READ-ONLY. Lists tracked/API-send stages on ACTIVE campaigns that have no
// provider_phone_id — these would now be blocked by the generalized kickoff
// no_sender_number gate (Task 3). Run BEFORE deploying that change so nothing
// in-flight is stranded. Run: npx tsx scripts/audit-stages-missing-sender.ts
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

async function main() {
  const rows = (await db.execute(sql`
    SELECT c.id AS campaign_id, c.name AS campaign_name, c.org_id,
           s.id AS stage_id, s.stage_number, p.name AS provider_name,
           p.sms_provider_id AS provider_key
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE c.status = 'active'
      AND c.link_mode = 'tracked'
      AND p.supports_api_send = true
      AND s.provider_phone_id IS NULL
    ORDER BY c.org_id, c.id, s.stage_number
  `)) as unknown as Record<string, unknown>[];

  if (rows.length === 0) {
    console.log("OK — no active tracked/API-send stages are missing a sender.");
  } else {
    console.log(`WARNING — ${rows.length} stage(s) would be blocked by the new gate:`);
    for (const r of rows) console.log(r);
  }
  process.exit(0);
}
void main();
```

- [ ] **Step 2: Run the audit against the shared DB**

Run: `npx tsx scripts/audit-stages-missing-sender.ts`
Expected: prints either `OK — no active ...` or a `WARNING` list. **If it warns, stop and report the list to the user** — assign phones to those stages before Task 3 ships to production. (Task 3 is already committed on the branch; deployment is gated on this audit being clean or the flagged stages being remediated.)

- [ ] **Step 3: Commit the script**

```bash
git add scripts/audit-stages-missing-sender.ts
git commit -m "chore(sends): read-only audit for active stages missing a sender"
```

---

## Task 11: Documentation

**Files:**
- Modify: `docs/03-data-model.md` (+ the Mermaid ERD: `campaigns.default_provider_phone_id` → `provider_phones`)
- Modify: the relevant file(s) under `docs/04-features/` (campaigns + sends)
- Modify: `docs/06-integrations.md` (TextHub `sender` parameter)
- Modify: `docs/07-conventions.md` (sender = national digits; API-send stages require a phone)
- Modify: `docs/CHANGELOG.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the data model + ERD**

In `docs/03-data-model.md`, document the new `campaigns.default_provider_phone_id` column (nullable FK → `provider_phones`, prefill-only, `ON DELETE SET NULL`) and add the relationship to the Mermaid ERD. Update the "last updated" date.

- [ ] **Step 2: Update feature docs**

In `docs/04-features/` (the campaigns and sends docs), describe: the campaign "Default send-from number" (prefill only), the stage phone as the TextHub `sender`, and the "API-send stages require a sending number" block. Update "last updated" dates.

- [ ] **Step 3: Update integrations**

In `docs/06-integrations.md`, add the TextHub `sender` parameter to the send request contract: value = national digits (no country code), sourced from the stage's `provider_phone_id`; omitted only never (a missing sender is now blocked before send). Update the date.

- [ ] **Step 4: Update conventions**

In `docs/07-conventions.md`, add: TextHub `sender` = phone national digits via `toTexthubSender`; every API-send (tracked) stage must have a `provider_phone_id` (enforced at kickoff + surfaced in preflight). Update the date.

- [ ] **Step 5: Append the changelog line**

Add to `docs/CHANGELOG.md`:

```
2026-07-22 — TextHub sender selection (sender param from the stage's phone; campaign default sender prefill; API-send stages now require a sending number) — docs 03,04,06,07 updated
```

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "docs(sends): document TextHub sender selection + campaign default sender"
```

---

## Task 12: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Run the send/adapter tests**

Run: `npx tsx scripts/test-texthub-send.ts`
Expected: `ALL PASS`.

- [ ] **Step 2: Run the drain verifier**

Run: `npx tsx scripts/verify-drain.ts`
Expected: `verify-drain OK.`

- [ ] **Step 3: Run the Ahoi send test (no regression)**

Run: `npx tsx scripts/test-ahoi-send.ts`
Expected: `ALL PASS` (proves the shared `SmsProviderAdapter` contract still holds).

- [ ] **Step 4: Typecheck + lint the whole project**

Run: `npx tsc --noEmit` then `npm run lint`
Expected: clean (no new errors/warnings from the changed files).

- [ ] **Step 5: Migration integrity**

Run: `npx tsx scripts/verify-migration-integrity.ts`
Expected: all-green, chain clean.

- [ ] **Step 6: Confirm the audit is clean (or remediated)**

Run: `npx tsx scripts/audit-stages-missing-sender.ts`
Expected: `OK — no active ...`. If it warns, the flagged stages must be assigned phones before this branch is deployed to production.

- [ ] **Step 7: Final summary**

Report: `Verified: TextHub sender param ✓, refuse-on-null ✓, kickoff gate generalized ✓, preflight check ✓, migration 0115 ✓, campaign default picker ✓, stage prefill ✓, audit ✓, docs ✓`.

---

## Self-Review Notes (author)

- **Spec coverage:** Part 1 → Tasks 1–2; Part 2 (campaign default) → Tasks 5–9; Part 3 (block) → Tasks 3–4 + adapter refuse-on-null (Task 2); pre-deploy audit → Task 10; tests → Tasks 1,2,12; docs → Task 11. All spec sections map to a task.
- **Type consistency:** `toTexthubSender` (Task 1) is consumed by name in Task 2; `sender` field name consistent across `SendSmsParams`/`buildSendUrl`/adapter; `no_sender_number` reuses the EXISTING `KickoffRefusal`/`KICKOFF_REFUSAL` value (Task 3) and is ADDED to `PreflightBlocker` (Task 4) — two distinct unions, intentionally. `default_provider_phone_id` spelled identically in schema, validator, both routes, and both form files. `ActivePhone` shape matches the Task 6 endpoint's select.
- **Ordering dependency:** Task 3's kickoff change only fires for API-send providers because it sits after the `supports_api_send` gate — confirmed by reading `kickoff.ts:219-229`. Task 10's audit must run (clean) before this branch deploys.
- **No placeholders:** every code step shows the actual code; the two JSON/JSX-heavy steps (snapshot clone in Task 5, picker JSX in Task 8) give the concrete shape and reference the exact existing pattern to copy.
