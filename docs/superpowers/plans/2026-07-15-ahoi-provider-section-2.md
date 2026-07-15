# Ahoi Provider — Section 2 (Send Path + Segment Policy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Ahoi's real `send()`/`buildRedactedRequest()` (always-HTTP-200, classify off the body), thread the stage's sender phone number through the drain into the adapter (Ahoi needs a `source` number; TextHub must stay byte-identical), and add a segment-count preflight gate (G8: single-segment default, per-creative override, hard ceiling) so Ahoi's silent multipart splitting can never runaway-bill or blow past 4 segments.

**Architecture:** Two independent workstreams sharing one seam (`lib/sends/providers/ahoi.ts`, `lib/sends/drain.ts`) and one new shared module (`lib/sends/segments.ts`):
- **A. Send path:** `ahoiAdapter.send()` posts form-encoded `key/source/destination/message` to `${AHOI_API_BASE_URL}/sms/send`, reads the body once as text (verbatim evidence), and classifies success/failure off the JSON `status` field — never off the HTTP status, which Ahoi always returns as 200. The resulting `SendSmsResult` flows through the **unchanged** `classifyAttempt`. The drain's `Sender` type gains an optional `senderNumber` field so TextHub's injected-fake test seam (`scripts/verify-drain.ts`) needs zero changes, while a real (non-injected) Ahoi send gets the stage's `provider_phones.phone_number`.
- **B. Segment policy:** `lib/sends/segments.ts` is a thin wrapper over the **already-existing** `calculateSmsSegments` in `lib/creative-helpers.ts` (live today in both the creative form's inline counter and the stage creative-picker dialog's warning badges) — it does not reimplement GSM-7/UCS-2 detection, it re-exports the same counting logic under the narrower shape the send path needs, plus the new `MAX_SEGMENTS` ceiling constant (G8). `creatives.allow_multi_segment` (new column, migration 0108) is the per-creative override. `lib/sends/kickoff.ts` computes one representative rendered-text segment count per stage (proven recipient-invariant within a stage — see Task 5) and refuses materialization before any recipient row is written if the text needs an override that isn't set, or exceeds the hard ceiling regardless of the override.

**Tech Stack:** Next.js 16 · TypeScript · Drizzle ORM · Postgres (Supabase) · `tsx` test scripts (no vitest/jest in this repo — tests are `scripts/test-*.ts` run via `npx tsx`) · react-hook-form + Zod (creative form).

## Global Constraints

- `SEND_ENABLED` stays **OFF** the entire phase (never flipped in this plan).
- **G2 — TextHub unchanged.** `lib/sends/texthub.ts` internals and `lib/sends/providers/texthub.ts` are not modified. `scripts/verify-drain.ts` must stay fully green after Task 2 — this is the regression proof, not optional.
- **G8 — segment ceiling.** `MAX_SEGMENTS = 4` lives in exactly one place (`lib/sends/segments.ts`) and is enforced at kickoff **even when** a creative's `allow_multi_segment` override is on. Never bypassable.
- Migrations are **hand-authored**, not generated (next index is `0108`); clone the latest snapshot forward + add the `_journal.json` entry (per `CLAUDE.md` "Migrations are hand-authored" + `scripts/verify-migration-integrity.ts`).
- **Task 4's migration apply is a HARD USER GATE.** `DATABASE_URL` points at the shared prod DB (per `CLAUDE.md §14` / Section 1 Task 4 precedent). The implementer authors the migration + journal + snapshot + schema.ts edit + test script and runs the test to confirm RED (column absent) — but does **not** run `npm run db:migrate`. A human must explicitly approve before the controller applies it, then re-runs the test to confirm GREEN.
- Tests are `tsx` scripts run via `npx tsx scripts/test-*.ts`, using the repo's `check(name, cond, detail)` idiom. A trailing Windows `Assertion failed … async.c` line after a script exits is harmless (known Node/tsx-on-Windows artifact, not a test failure).
- Reuse over reimplementation: segment counting already has one canonical implementation (`lib/creative-helpers.ts`'s `calculateSmsSegments`, consumed today by both `components/creatives/creative-form.tsx` and `components/campaigns/creative-picker-dialog.tsx`). `lib/sends/segments.ts` wraps it; it does not fork a third copy of the GSM-7/UCS-2 rules.

---

## File Structure

**New:**
- `lib/sends/segments.ts` — `MAX_SEGMENTS` (G8) + `countSegments(text)`, thin wrapper over `calculateSmsSegments`.
- `db/migrations/0108_creatives_allow_multi_segment.sql` — adds `creatives.allow_multi_segment boolean not null default false`.
- `db/migrations/meta/0108_snapshot.json` — cloned from `0107_snapshot.json` + the new column + updated `id`/`prevId`.
- `scripts/test-ahoi-send.ts` — Ahoi `send()`/`buildRedactedRequest()` classification (stubbed `fetch`, no network).
- `scripts/test-drain-sender-number.ts` — proves `stage.sender_number` flows DB-column → `resolveSenderForStage` → `adapter.send` → the real Ahoi request body (stubbed `fetch`).
- `scripts/test-segments.ts` — GSM-7/UCS-2/ceiling boundary tests for `countSegments`/`MAX_SEGMENTS`.
- `scripts/test-creatives-allow-multi-segment-column.ts` — `information_schema` check that migration 0108 landed correctly (read-only, no writes).
- `scripts/test-kickoff-segments.ts` — end-to-end kickoff refusal/allow behavior for the 4 segment-policy cases (rolled-back tx).

**Modified:**
- `lib/sends/providers/ahoi.ts` — real `send()`/`buildRedactedRequest()` (Task 1).
- `lib/sends/drain.ts` — `Sender` type gains optional `senderNumber`; ctx query selects `pp.phone_number AS sender_number`; `resolveSenderForStage`'s closure and both send-call and redaction-call sites thread it through (Task 2).
- `lib/links/mint-link.ts` — export the existing private `CODE_LENGTH` constant so `kickoff.ts` can build a representative fixed-width link without duplicating the value (Task 5).
- `db/schema.ts` — `creatives` table gains `allow_multi_segment` (Task 4).
- `db/migrations/meta/_journal.json` — new entry for `0108` (Task 4).
- `lib/sends/kickoff.ts` — `KickoffRefusal` gains `multi_segment_not_allowed` / `segment_ceiling_exceeded`; `MainRow` gains `creative_allow_multi_segment`; new preflight guard before recipient enumeration (Task 5).
- `lib/sends/kickoff-refusals.ts` — messages for the two new refusals (Task 5).
- `lib/sends/scheduled.ts` — `PERMANENT_REFUSALS` gains the two new refusals (won't self-resolve within a scheduled window) (Task 5).
- `lib/validators/creatives.ts` — `allow_multi_segment` on create/update schemas (Task 6).
- `components/creatives/creative-form.tsx` — `allow_multi_segment` field + toggle + live warning (Task 6).
- `app/api/creatives/route.ts` — `handleSingle` insert + `loadCreativeWithOffers` select carry the new column (Task 6).
- `app/api/creatives/[id]/route.ts` — GET select carries the new column (PATCH needs no change — its update-builder is already generic) (Task 6).
- `app/(protected)/creatives/page.tsx` — `Creative` type, edit-dialog `initialValues`, `handleEdit` PATCH body (Task 6).
- `.env.example`, `docs/06-integrations.md` — `AHOI_API_BASE_URL` (new) + `AHOI_API_TOKEN` (introduced in Section 1's seed script but never documented — fixed here since Task 1 touches this exact section) (Task 1).
- `docs/03-data-model.md`, `docs/04-features/sms-send-pipeline.md`, `docs/04-features/campaigns-stages-creatives.md`, `docs/07-conventions.md`, `docs/CHANGELOG.md` — updated per task (see each task's Step).

---

## Task 1: Ahoi `send()` + `buildRedactedRequest()`

**Files:**
- Modify: `lib/sends/providers/ahoi.ts`
- Modify: `.env.example`, `docs/06-integrations.md`
- Test: `scripts/test-ahoi-send.ts`

**Interfaces:**
- Consumes: `NormalizedSendParams`, `SendSmsResult`, `SmsProviderAdapter` from `./types` (unchanged from Section 1).
- Produces: `ahoiAdapter.send(p)` and `ahoiAdapter.buildRedactedRequest(p)` are real; `toAhoiRecipient` (Section 1) is reused, not duplicated.

- [ ] **Step 1: Write the failing test** — `scripts/test-ahoi-send.ts`

```ts
// Ahoi send() classification: the platform ALWAYS returns HTTP 200 — the
// real result is the body `status` field (Phase 0 fact). This test stubs
// global fetch (no network) and asserts every body shape maps to the
// SendSmsResult contract classifyAttempt already knows how to bucket.
// Run: npx tsx scripts/test-ahoi-send.ts
import { ahoiAdapter } from "@/lib/sends/providers/ahoi";
import { classifyAttempt } from "@/lib/sends/classify-attempt";
import type { NormalizedSendParams } from "@/lib/sends/providers/types";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

const baseParams: NormalizedSendParams = {
  apiKey: "test-key",
  text: "hello",
  recipientE164: "+15642155963",
  senderNumber: "+13158359592",
  leadId: null,
};

function stubFetch(body: unknown, status = 200) {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => ({
    status,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

async function main() {
  // {status:"ok",uuid} -> accepted
  stubFetch({ status: "ok", uuid: "s-abc123" });
  const ok = await ahoiAdapter.send(baseParams);
  check("ok body -> ok:true", ok.ok === true);
  check("ok body -> messageId captured", ok.messageId === "s-abc123");
  check("ok body -> status 200 (HTTP always-200 fact)", ok.status === 200);
  check("ok body -> suppressed always false (Ahoi has no per-send suppression)", ok.suppressed === false);
  check(
    "classifyAttempt buckets it 'accepted'",
    classifyAttempt({ ok: ok.ok, status: ok.status, messageId: ok.messageId, timedOut: ok.timedOut }) === "accepted",
  );

  // {status:"error",error} -> theirs_rejected (still HTTP 200)
  stubFetch({ status: "error", error: "invalid destination" });
  const err = await ahoiAdapter.send(baseParams);
  check("error body -> ok:false", err.ok === false);
  check("error body -> error message captured", err.error === "invalid destination");
  check("error body -> status still 200 (not 0)", err.status === 200);
  check(
    "classifyAttempt buckets it 'theirs_rejected'",
    classifyAttempt({ ok: err.ok, status: err.status, messageId: err.messageId, timedOut: err.timedOut }) === "theirs_rejected",
  );

  // Network failure -> status 0, mine_transport
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const net = await ahoiAdapter.send(baseParams);
  check("network failure -> status 0", net.status === 0);
  check("network failure -> not timed out (connection failure, not abort)", net.timedOut === false);
  check(
    "classifyAttempt buckets it 'mine_transport'",
    classifyAttempt({ ok: net.ok, status: net.status, messageId: net.messageId, timedOut: net.timedOut }) === "mine_transport",
  );

  // Missing sender number -> clean refusal, never throws, never calls fetch.
  let fetchCalled = false;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as unknown as typeof fetch;
  const noSender = await ahoiAdapter.send({ ...baseParams, senderNumber: null });
  check("no senderNumber -> ok:false without a network call", noSender.ok === false && !fetchCalled);
  check(
    "no senderNumber -> classifyAttempt buckets it 'mine_transport' (our config issue)",
    classifyAttempt({ ok: noSender.ok, status: noSender.status, messageId: noSender.messageId, timedOut: noSender.timedOut }) ===
      "mine_transport",
  );

  // Redaction never includes the real api_key; uses 10-digit source/destination.
  const redacted = ahoiAdapter.buildRedactedRequest({ ...baseParams, apiKey: "redacted_1234" });
  check("redacted request carries the placeholder, not a real key", redacted.includes("redacted_1234"));
  check("redacted request never carries the raw apiKey", !redacted.includes(baseParams.apiKey));
  check(
    "redacted request uses 10-digit source/destination (toProviderRecipient)",
    redacted.includes("destination=5642155963") && redacted.includes("source=3158359592"),
    redacted,
  );

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-ahoi-send.ts`
Expected: FAIL — `ahoiAdapter.send`/`buildRedactedRequest` still throw `"not implemented until Section 2"`.

- [ ] **Step 3: Implement `lib/sends/providers/ahoi.ts`**

Replace the whole file:

```ts
// Ahoi (api19/CallAPI) adapter. Section 1 built the skeleton (recipient
// conversion). Section 2 implements send()/buildRedactedRequest(); parseDlr/
// parseInbound remain Section 3.
import type {
  DlrEvent, InboundEvent, NormalizedSendParams, RawWebhook,
  SendSmsResult, SmsProviderAdapter,
} from "./types";

// Recon default (Phase 0). Overridable via AHOI_API_BASE_URL for a different
// white-label account/base without a redeploy of code, but the adapter works
// out of the box even if the env var is never set.
const AHOI_DEFAULT_BASE_URL = "https://v1.api19.com";
const DEFAULT_TIMEOUT_MS = 15000;

function ahoiBaseUrl(): string {
  return process.env.AHOI_API_BASE_URL ?? AHOI_DEFAULT_BASE_URL;
}

// E.164 US (+1XXXXXXXXXX) or 1XXXXXXXXXX -> bare 10-digit XXXXXXXXXX.
export function toAhoiRecipient(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits; // already 10-digit (or leave as-is for non-US, handled later)
}

interface AhoiSendParams {
  apiKey: string;
  text: string;
  source: string; // 10-digit sending number
  destination: string; // 10-digit recipient number
  timeoutMs?: number;
}

// Pure form-body builder — exported shape (key/source/destination/message,
// no extras) is reused for BOTH the real send and the redacted audit string,
// so they can never drift apart.
function buildSendBody(p: AhoiSendParams): URLSearchParams {
  const body = new URLSearchParams();
  body.set("key", p.apiKey);
  body.set("source", p.source);
  body.set("destination", p.destination);
  body.set("message", p.text);
  return body;
}

// Send one SMS via Ahoi. Ahoi ALWAYS returns HTTP 200 (Phase 0 fact) — the
// real result is the body `status` field. Classification is off the body,
// not the HTTP status; a non-200 HTTP status is still handled defensively
// (never throws) even though it isn't observed in practice. Mirrors
// lib/sends/texthub.ts's robustness: AbortController timeout, read the body
// once as text (verbatim evidence), never throw.
async function ahoiSendSms(p: AhoiSendParams): Promise<SendSmsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${ahoiBaseUrl()}/sms/send`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: buildSendBody(p),
      signal: controller.signal,
    });

    let rawBody: string | null = null;
    try {
      rawBody = await res.text();
    } catch {
      rawBody = null;
    }
    let parsed: { status?: unknown; uuid?: unknown; error?: unknown } = {};
    if (rawBody) {
      try {
        parsed = JSON.parse(rawBody) as typeof parsed;
      } catch {
        // Non-JSON body — leave parsed fields empty; rawBody is still captured.
      }
    }
    const bodyStatus = typeof parsed.status === "string" ? parsed.status.trim().toLowerCase() : null;
    const uuid = typeof parsed.uuid === "string" ? parsed.uuid : null;
    const errorMsg = typeof parsed.error === "string" ? parsed.error : null;

    if (bodyStatus === "ok" && uuid) {
      return {
        ok: true,
        messageId: uuid,
        response: bodyStatus,
        providerStatus: bodyStatus,
        suppressed: false, // Ahoi has no per-send suppressed status (spec §4)
        rawBody,
        error: null,
        status: res.status,
        timedOut: false,
      };
    }
    return {
      ok: false,
      messageId: null,
      response: errorMsg,
      providerStatus: bodyStatus,
      suppressed: false,
      rawBody,
      error: errorMsg ?? `Ahoi returned status="${bodyStatus ?? "unknown"}"`,
      status: res.status,
      timedOut: false,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      messageId: null,
      response: null,
      providerStatus: null,
      suppressed: false,
      rawBody: null,
      error: aborted ? "Ahoi request timed out" : "Ahoi network error",
      status: 0,
      timedOut: aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Redacted form-body string for the send_attempts audit log — built from the
// SAME buildSendBody the real send uses, with the api_key replaced by the
// caller-supplied redacted placeholder (never the real key).
function buildRedactedBody(p: NormalizedSendParams): string {
  const body = buildSendBody({
    apiKey: p.apiKey,
    text: p.text,
    source: p.senderNumber ? toAhoiRecipient(p.senderNumber) : "",
    destination: toAhoiRecipient(p.recipientE164),
  });
  return `POST ${ahoiBaseUrl()}/sms/send  ${body.toString()}`;
}

export const ahoiAdapter: SmsProviderAdapter = {
  key: "ahoi",
  toProviderRecipient: toAhoiRecipient,
  async send(p: NormalizedSendParams): Promise<SendSmsResult> {
    if (!p.senderNumber) {
      // Ahoi requires a `source` number; a stage with no provider_phone_id
      // assigned can't send. Refuse cleanly (never throw, never post a
      // malformed request) — this is OUR misconfiguration, not theirs, so it
      // classifies as mine_transport (status 0, not timed out).
      return {
        ok: false,
        messageId: null,
        response: null,
        providerStatus: null,
        suppressed: false,
        rawBody: null,
        error: "ahoi: no sender number configured for this stage",
        status: 0,
        timedOut: false,
      };
    }
    return ahoiSendSms({
      apiKey: p.apiKey,
      text: p.text,
      source: toAhoiRecipient(p.senderNumber),
      destination: toAhoiRecipient(p.recipientE164),
    });
  },
  buildRedactedRequest(p: NormalizedSendParams): string {
    return buildRedactedBody(p);
  },
  parseDlr(_raw: RawWebhook): DlrEvent | null {
    throw new Error("ahoi.parseDlr not implemented until Section 3");
  },
  parseInbound(_raw: RawWebhook): InboundEvent | null {
    throw new Error("ahoi.parseInbound not implemented until Section 3");
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-ahoi-send.ts`
Expected: PASS — `ALL PASS`, exit 0.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Document the new env var (+ fix a Section 1 doc gap)**

`AHOI_API_TOKEN` was introduced by Section 1's `scripts/seed-ahoi-number-credential.ts` but never added to `.env.example`/`docs/06-integrations.md`. Add both it and the new `AHOI_API_BASE_URL` together since this step is already touching this section.

In `.env.example`, after the `TELEGRAM_CHAT_ID=` line (before the Keitaro section), add:

```
# ============================================================
# SMS sending (Ahoi / api19-CallAPI white-label) — Phase 1 Section 2
# ============================================================
# Optional base-URL override for the Ahoi/api19 platform (defaults to
# https://v1.api19.com). The Ahoi api_key itself is NOT here — it's stored
# per provider in provider_credentials (multi-tenant), same as TextHub's.
# AHOI_API_BASE_URL=https://v1.api19.com

# One-time seed token for scripts/seed-ahoi-number-credential.ts, which
# copies it into provider_credentials.api_key. Not read by the app at
# runtime after seeding — remove once the seed has run.
# AHOI_API_TOKEN=
```

In `docs/06-integrations.md`, add a table row alongside the TextHub row:

```
| **Ahoi** (api19/CallAPI white-label) | app ↔ provider | send (Section 2) | `key` form/query param (DB, provider-default) | send: `POST {AHOI_API_BASE_URL}/sms/send` form body `key/source/destination/message` → **always HTTP 200**; classify off body `{status:"ok",uuid}` / `{status:"error",error}` |
```

And an env-var table row:

```
| `AHOI_API_BASE_URL` | server | optional override for the Ahoi/api19 base URL (default `https://v1.api19.com`) |
| `AHOI_API_TOKEN` | **local only** | one-time seed input for `scripts/seed-ahoi-number-credential.ts`; not read at runtime after seeding |
```

Add a gotcha callout paragraph near the TextHub gotchas paragraph:

```
> Ahoi gotchas (`lib/sends/providers/ahoi.ts`): the platform **always returns HTTP 200** — never trust the HTTP status, classify off the body `status` field only. Numbers are 10-digit with no `+1` on the wire in both directions (`toAhoiRecipient`/re-add `+1` on the way back). Portal "Enforce GSM/160" settings have no effect — Ahoi silently sends Unicode and splits messages over 160 chars into billed segments, which is why the segment-count preflight gate (`lib/sends/segments.ts`, G8) exists.
```

Update the "Last updated" date at the top of `docs/06-integrations.md` to `2026-07-15`.

- [ ] **Step 7: Append to `docs/CHANGELOG.md`**

```
## 2026-07-15 — Ahoi send() + buildRedactedRequest() implemented (Section 2 Task 1) — docs/06-integrations.md
```

- [ ] **Step 8: Commit**

```bash
git add lib/sends/providers/ahoi.ts scripts/test-ahoi-send.ts .env.example docs/06-integrations.md docs/CHANGELOG.md
git commit -m "feat(ahoi): implement send() + buildRedactedRequest (always-200 body classification)"
```

---

## Task 2: Thread `senderNumber` through the drain (G2 proof)

**Files:**
- Modify: `lib/sends/drain.ts`
- Test: `scripts/test-drain-sender-number.ts`

**Interfaces:**
- Consumes: `ahoiAdapter.send` (Task 1, real); `resolveSenderForStage` (Section 1, unchanged signature).
- Produces: `Sender`'s opts gain optional `senderNumber`; the ctx query and result-row type gain `sender_number`; both the send call and the redaction call thread it through.

- [ ] **Step 1: Add `pp.phone_number AS sender_number` to the ctx query (CONFIRMED trivial)**

CONFIRMED (read-only): `lib/sends/drain.ts:193` already `LEFT JOIN provider_phones pp ON pp.id = s.provider_phone_id` for `max_sends_per_second` — the phone's `phone_number` column is one more SELECT item on the same join, no new join needed.

In `lib/sends/drain.ts`, change the SELECT (~line 189):

```sql
           pp.max_sends_per_second AS max_sends_per_second,
           pp.phone_number         AS sender_number
```

And the result row type (~line 206), add after `max_sends_per_second: number | null;`:

```ts
    sender_number: string | null;
```

- [ ] **Step 2: Write the failing test** — `scripts/test-drain-sender-number.ts`

```ts
// Proves stage.sender_number flows: resolveSenderForStage's closure ->
// adapter.send's NormalizedSendParams -> the real Ahoi request body. No
// network (fetch stubbed), no DB (resolveSenderForStage is exercised
// directly with providerKey="ahoi" — the registry resolution itself was
// proven in Section 1's test-ahoi-registry.ts).
// Run: npx tsx scripts/test-drain-sender-number.ts
import { resolveSenderForStage } from "@/lib/sends/drain";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  let capturedBody: string | null = null;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: RequestInit,
  ) => {
    capturedBody = String(init?.body ?? "");
    return {
      status: 200,
      text: async () => JSON.stringify({ status: "ok", uuid: "s-1" }),
    };
  }) as unknown as typeof fetch;

  const sendSms = resolveSenderForStage("ahoi");
  await sendSms({
    apiKey: "k",
    text: "hi",
    number: "+15642155963",
    leadId: null,
    senderNumber: "+13158359592",
  });
  check(
    "resolved ahoi sender posts the stage's sender_number as `source` (10-digit)",
    (capturedBody ?? "").includes("source=3158359592"),
    capturedBody ?? "null",
  );

  // senderNumber omitted entirely (Sender's new field is OPTIONAL — an older
  // TextHub-shaped call site must still compile and run). The resolved ahoi
  // closure forwards null and ahoi.send refuses cleanly rather than posting
  // a malformed request.
  const sendSmsNoSender = resolveSenderForStage("ahoi");
  const res = await sendSmsNoSender({ apiKey: "k", text: "hi", number: "+15642155963" });
  check("senderNumber omitted -> ahoi.send refuses without throwing", res.ok === false);

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx scripts/test-drain-sender-number.ts`
Expected: FAIL — the resolved ahoi sender currently hardcodes `senderNumber: null`, so `capturedBody` never contains `source=3158359592`.

- [ ] **Step 4: Update the `Sender` type**

In `lib/sends/drain.ts` (~line 50-55), replace:

```ts
export type Sender = (opts: {
  apiKey: string;
  text: string;
  number: string;
  leadId?: string | null;
}) => Promise<SendSmsResult>;
```

with:

```ts
export type Sender = (opts: {
  apiKey: string;
  text: string;
  number: string;
  leadId?: string | null;
  // Stage's provider_phones.phone_number (E.164), for adapters that need a
  // sending number (Ahoi). OPTIONAL so existing injected test fakes
  // (scripts/verify-drain.ts) that don't destructure it keep compiling
  // unchanged. TextHub's adapter ignores it.
  senderNumber?: string | null;
}) => Promise<SendSmsResult>;
```

- [ ] **Step 5: Thread it through `resolveSenderForStage`'s closure**

In `lib/sends/drain.ts` (~line 114-119), replace:

```ts
export function resolveSenderForStage(providerKey: string, injected?: Sender): Sender {
  if (injected) return injected;
  const adapter = getAdapter(providerKey);
  return ({ apiKey, text, number, leadId }) =>
    adapter.send({ apiKey, text, recipientE164: number, senderNumber: null, leadId });
}
```

with:

```ts
export function resolveSenderForStage(providerKey: string, injected?: Sender): Sender {
  if (injected) return injected;
  const adapter = getAdapter(providerKey);
  return ({ apiKey, text, number, leadId, senderNumber }) =>
    adapter.send({ apiKey, text, recipientE164: number, senderNumber: senderNumber ?? null, leadId });
}
```

- [ ] **Step 6: Thread it through the send call site**

In `lib/sends/drain.ts` (~line 404-411), the slice's send call currently omits `senderNumber`. Replace:

```ts
      const results = await Promise.all(
        slice.map((c) =>
          sendSms({ apiKey, text: c.rendered_text, number: c.phone, leadId: c.lead_id }),
        ),
      );
```

with:

```ts
      const results = await Promise.all(
        slice.map((c) =>
          sendSms({
            apiKey, text: c.rendered_text, number: c.phone, leadId: c.lead_id,
            senderNumber: stage.sender_number,
          }),
        ),
      );
```

- [ ] **Step 7: Thread it through the redaction call site too (found beyond the literal brief)**

The redaction call (~line 465-471) ALSO hardcodes `senderNumber: null` — left as-is, the `send_attempts` audit log would always show an empty `source` for a real Ahoi send even though the actual request carried a real one. Fix it for the same reason: the redacted request must accurately reflect the real request (Workstream 3's audit-evidence guarantee). Replace:

```ts
        const requestRedacted = buildRedacted({
          apiKey: `redacted_${keyLast4}`,
          text: c.rendered_text,
          recipientE164: c.phone,
          senderNumber: null,
          leadId: c.lead_id,
        });
```

with:

```ts
        const requestRedacted = buildRedacted({
          apiKey: `redacted_${keyLast4}`,
          text: c.rendered_text,
          recipientE164: c.phone,
          senderNumber: stage.sender_number,
          leadId: c.lead_id,
        });
```

- [ ] **Step 8: Run the new test to verify it passes**

Run: `npx tsx scripts/test-drain-sender-number.ts`
Expected: PASS — `ALL PASS`, exit 0.

- [ ] **Step 9: G2 PROOF — run verify-drain, confirm fully green (TextHub unaffected)**

Run: `npx tsx scripts/verify-drain.ts`
Expected: PASS — all assertions green, ending `verify-drain OK.`. `verify-drain.ts`'s injected fakes (`okSender`, `failSender`, `suppressedSender`, `pausingSender`, `concSender`) are all zero-arg-ignoring closures (`async () => ({...})`), so the new optional `senderNumber` field requires zero changes there — this run proves it. TextHub's real adapter (`lib/sends/providers/texthub.ts`) ignores `senderNumber` entirely (Section 1), so its behavior is unaffected regardless.

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add lib/sends/drain.ts scripts/test-drain-sender-number.ts
git commit -m "feat(ahoi): thread stage sender_number through drain into adapter.send (G2 proven)"
```

---

## Task 3: `lib/sends/segments.ts` (GSM-7/UCS-2 counting + G8 ceiling)

**Files:**
- Create: `lib/sends/segments.ts`
- Modify: `docs/07-conventions.md`
- Test: `scripts/test-segments.ts`

**Interfaces:**
- Consumes: `calculateSmsSegments` from `@/lib/creative-helpers` (existing, unchanged — already live in `components/creatives/creative-form.tsx` and `components/campaigns/creative-picker-dialog.tsx`; NOT reimplemented here).
- Produces: `export const MAX_SEGMENTS = 4` (G8), `export function countSegments(text): { encoding: "GSM-7" | "UCS-2"; chars: number; segments: number }`.

- [ ] **Step 1: Write the failing test** — `scripts/test-segments.ts`

```ts
// Segment counting used by the kickoff G8 gate. Wraps the EXISTING GSM-7/
// UCS-2 counter (lib/creative-helpers.ts calculateSmsSegments — already live
// in the creative-form UI and the stage creative-picker dialog) so the
// send-path gate and both UIs can never diverge on what counts as "1
// segment". Adds MAX_SEGMENTS (G8) + the narrower {encoding,chars,segments}
// shape the send path consumes.
// Run: npx tsx scripts/test-segments.ts
import { countSegments, MAX_SEGMENTS } from "@/lib/sends/segments";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

check("MAX_SEGMENTS is 4 (G8)", MAX_SEGMENTS === 4);

// GSM-7 boundary: 160 chars = 1 segment, 161 = 2 (concatenated framing, 153/seg).
const gsm159 = countSegments("A".repeat(159));
check("159 GSM-7 chars -> 1 segment", gsm159.segments === 1 && gsm159.encoding === "GSM-7", JSON.stringify(gsm159));
const gsm160 = countSegments("A".repeat(160));
check("160 GSM-7 chars -> 1 segment (exact boundary)", gsm160.segments === 1, JSON.stringify(gsm160));
const gsm161 = countSegments("A".repeat(161));
check("161 GSM-7 chars -> 2 segments", gsm161.segments === 2, JSON.stringify(gsm161));

// UCS-2 boundary: 70 chars = 1 segment, 71 = 2 (67/seg concatenated).
// NOTE: use a genuinely non-GSM-7 BMP char (中, 1 UTF-16 unit). Do NOT use
// accented Latin like é/à/ñ/ü — those ARE in the GSM-7 basic set (GSM 03.38)
// and count as GSM-7, so they would NOT exercise the UCS-2 path. (Verified
// against the live calculateSmsSegments: "é".repeat(70) => GSM-7, 1 segment.)
const ucs70 = countSegments("中".repeat(70));
check("70 UCS-2 chars -> 1 segment", ucs70.segments === 1 && ucs70.encoding === "UCS-2", JSON.stringify(ucs70));
const ucs71 = countSegments("中".repeat(71));
check("71 UCS-2 chars -> 2 segments", ucs71.segments === 2, JSON.stringify(ucs71));

// An emoji forces UCS-2 even in an otherwise pure-GSM-7 message.
const emoji = countSegments("Hello 😀");
check("emoji forces UCS-2 encoding", emoji.encoding === "UCS-2", JSON.stringify(emoji));

// Ceiling math: a GSM-7 message just over 4*153 chars exceeds MAX_SEGMENTS;
// exactly 4*153 is AT the ceiling, not over.
const overCeiling = countSegments("A".repeat(4 * 153 + 1));
check("4*153+1 GSM-7 chars exceeds MAX_SEGMENTS", overCeiling.segments > MAX_SEGMENTS, JSON.stringify(overCeiling));
const atCeiling = countSegments("A".repeat(4 * 153));
check("exactly 4*153 GSM-7 chars is AT the ceiling (not over)", atCeiling.segments === MAX_SEGMENTS, JSON.stringify(atCeiling));

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-segments.ts`
Expected: FAIL — module `@/lib/sends/segments` not found.

- [ ] **Step 3: Create `lib/sends/segments.ts`**

```ts
// Segment counting for the send path (G8 preflight gate, spec §4). Wraps the
// EXISTING GSM-7/UCS-2 implementation in lib/creative-helpers.ts — that
// function is already live in the creative-form inline counter and the stage
// creative-picker dialog's warning badges, so a third reimplementation here
// would risk the send-path gate silently diverging from what the operator
// sees on screen. This module adds only what the send path needs on top:
// the MAX_SEGMENTS hard ceiling and a narrower return shape.
import { calculateSmsSegments } from "@/lib/creative-helpers";

// G8: hard ceiling — text over this many segments is refused at kickoff
// preflight EVEN WITH a creative's allow_multi_segment override on. Tune
// here only (single source of truth).
export const MAX_SEGMENTS = 4;

export type SmsEncoding = "GSM-7" | "UCS-2";

export interface SegmentCount {
  encoding: SmsEncoding;
  chars: number;
  segments: number;
}

export function countSegments(text: string): SegmentCount {
  const r = calculateSmsSegments(text);
  return { encoding: r.charset, chars: r.characters, segments: r.segments };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-segments.ts`
Expected: PASS — `ALL PASS`, exit 0.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Document G8 in conventions**

In `docs/07-conventions.md`, under the `## Sending safety` section, add:

```
- **Segment ceiling (G8, Ahoi Phase 1 Section 2).** `MAX_SEGMENTS = 4` in `lib/sends/segments.ts` is a hard ceiling enforced at kickoff preflight (`lib/sends/kickoff.ts`) — text rendering to more segments than this is refused (`segment_ceiling_exceeded`) regardless of the creative's `allow_multi_segment` override. Default policy is single-segment-only (`creatives.allow_multi_segment = false`); the override permits 2–`MAX_SEGMENTS` segments, never unlimited. `countSegments()` wraps the existing `calculateSmsSegments` (`lib/creative-helpers.ts`) — do not fork a second GSM-7/UCS-2 implementation.
```

Update the "Last updated" date at the top if the file has one.

- [ ] **Step 7: Append to `docs/CHANGELOG.md`**

```
## 2026-07-15 — Segment counting + G8 ceiling (lib/sends/segments.ts, Section 2 Task 3) — docs/07-conventions.md
```

- [ ] **Step 8: Commit**

```bash
git add lib/sends/segments.ts scripts/test-segments.ts docs/07-conventions.md docs/CHANGELOG.md
git commit -m "feat(ahoi): segment counting util (G8 ceiling) wrapping the existing GSM-7/UCS-2 counter"
```

---

## Task 4: `creatives.allow_multi_segment` migration (HARD USER GATE)

**Files:**
- Create: `db/migrations/0108_creatives_allow_multi_segment.sql`
- Create: `db/migrations/meta/0108_snapshot.json`
- Modify: `db/migrations/meta/_journal.json`, `db/schema.ts`
- Modify: `docs/03-data-model.md`
- Test: `scripts/test-creatives-allow-multi-segment-column.ts`

**Interfaces:**
- Produces: `creatives.allow_multi_segment boolean not null default false` in both the DB and the Drizzle schema.

- [ ] **Step 1: Write the failing test** — `scripts/test-creatives-allow-multi-segment-column.ts`

```ts
// Verifies migration 0108 added creatives.allow_multi_segment (boolean, NOT
// NULL, default false). Schema-only check (information_schema) — no writes
// to the shared prod creatives table. Run AFTER the migration is applied.
// Run: npx tsx scripts/test-creatives-allow-multi-segment-column.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  const col = await sql`
    SELECT data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'creatives' AND column_name = 'allow_multi_segment'
  `;
  check("column exists", col.length === 1, JSON.stringify(col));
  check("type is boolean", col[0]?.data_type === "boolean");
  check("NOT NULL", col[0]?.is_nullable === "NO");
  check("default is false", (col[0]?.column_default ?? "").toLowerCase().startsWith("false"));
  await sql.end();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `npx tsx scripts/test-creatives-allow-multi-segment-column.ts`
Expected: FAIL — `column exists` ✗ (migration not applied yet).

- [ ] **Step 3: Author `db/migrations/0108_creatives_allow_multi_segment.sql`**

```sql
-- Section 2 (send path + segment policy): per-creative override for the
-- default single-segment-only send policy (spec §4). Default false: a
-- creative that renders to >1 SMS segment is refused at kickoff preflight
-- (lib/sends/kickoff.ts) unless this is explicitly turned on. The
-- MAX_SEGMENTS hard ceiling (G8, lib/sends/segments.ts) still applies even
-- when this is true — the override enables 2-4 segments, never runaway
-- multipart.
ALTER TABLE public.creatives
  ADD COLUMN allow_multi_segment boolean NOT NULL DEFAULT false;
```

- [ ] **Step 4: Add the Drizzle schema column**

In `db/schema.ts`, inside the `creatives` table definition, immediately after `applies_to_all_offers`:

```ts
    applies_to_all_offers: boolean("applies_to_all_offers")
      .notNull()
      .default(false),
    // Segment policy override (Ahoi Section 2, spec §4). Default false: the
    // creative is refused at kickoff preflight if its rendered text (+ link
    // + brand prefix + stop text) exceeds 1 SMS segment. Turning this on
    // allows up to MAX_SEGMENTS (G8, lib/sends/segments.ts) — never
    // unlimited.
    allow_multi_segment: boolean("allow_multi_segment")
      .notNull()
      .default(false),
```

- [ ] **Step 5: Add the `_journal.json` entry**

In `db/migrations/meta/_journal.json`, append after the `0107_seed_ahoi_provider` entry (currently the last):

```json
    ,
    {
      "idx": 108,
      "version": "7",
      "when": 1785715200000,
      "tag": "0108_creatives_allow_multi_segment",
      "breakpoints": true
    }
```

(i.e. add a comma after the `0107` entry's closing `}` and insert this object before the closing `]`.)

- [ ] **Step 6: Clone the snapshot**

Copy `db/migrations/meta/0107_snapshot.json` to `db/migrations/meta/0108_snapshot.json`. Edit two things:
1. Top-level `"id"` → `"0108a000-0108-4108-8108-000000000108"`, `"prevId"` → `"0107a000-0107-4107-8107-000000000107"` (was `"id": "0107a000-…", "prevId": "0106a000-…"`).
2. Inside the `creatives` table's `columns` object, immediately after the `applies_to_all_offers` entry, insert:

```json
        "allow_multi_segment": {
          "name": "allow_multi_segment",
          "type": "boolean",
          "primaryKey": false,
          "notNull": true,
          "default": false
        },
```

- [ ] **Step 7: STOP — HARD USER GATE**

Do **NOT** run `npm run db:migrate`. `DATABASE_URL` points at the shared prod DB used by the live app. Show the user:
- The migration SQL (Step 3) — a single additive `ADD COLUMN … NOT NULL DEFAULT false`, no data migration, no lock-heavy backfill.
- Confirmation that `scripts/test-creatives-allow-multi-segment-column.ts` is currently RED (Step 2's output).

Wait for explicit user go-ahead before proceeding to Step 8.

- [ ] **Step 8 (controller-run, after explicit go-ahead): Apply + verify**

```bash
npm run db:migrate
npx tsx scripts/verify-migration-integrity.ts
npx tsx scripts/test-creatives-allow-multi-segment-column.ts
```

Expected: `db:migrate` applies only `0108`; integrity chain all-green; the column test now PASSes (GREEN).

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (confirms `db/schema.ts`'s new column doesn't break any existing `creatives` insert/select call site — none reference every column exhaustively via a type error at this point since the column is optional-with-default on insert).

- [ ] **Step 10: Update `docs/03-data-model.md`**

In the table row for `creatives` (currently listing `slug`, `creative_id`, `text`, `quality`, `sequence_placement`, `funnel_stage`, `applies_to_all_offers`, spam columns), add `allow_multi_segment` to the column list and a short note: "`allow_multi_segment` (migration `0108`) — per-creative override for the single-segment-only send policy; enforced at kickoff preflight, see `docs/07-conventions.md` G8."

- [ ] **Step 11: Append to `docs/CHANGELOG.md`**

```
## 2026-07-15 — creatives.allow_multi_segment (migration 0108) — docs/03-data-model.md
```

- [ ] **Step 12: Commit**

```bash
git add db/migrations/0108_creatives_allow_multi_segment.sql db/migrations/meta/ db/schema.ts scripts/test-creatives-allow-multi-segment-column.ts docs/03-data-model.md docs/CHANGELOG.md
git commit -m "feat(ahoi): creatives.allow_multi_segment column (migration 0108, segment policy override)"
```

---

## Task 5: Kickoff enforcement (G8 hard gate)

**Files:**
- Modify: `lib/links/mint-link.ts` (export `CODE_LENGTH`)
- Modify: `lib/sends/kickoff.ts`, `lib/sends/kickoff-refusals.ts`, `lib/sends/scheduled.ts`
- Modify: `docs/04-features/sms-send-pipeline.md`
- Test: `scripts/test-kickoff-segments.ts`

**Interfaces:**
- Consumes: `countSegments`, `MAX_SEGMENTS` (Task 3); `creatives.allow_multi_segment` (Task 4, applied); `CODE_LENGTH` (this task, newly exported).
- Produces: `KickoffRefusal` gains `multi_segment_not_allowed` / `segment_ceiling_exceeded`; `kickoffStageSend` refuses before any recipient enumeration/materialization when the gate trips.

**Design note (confirmed, not assumed):** within one stage, the rendered text is recipient-invariant. In tracked mode, `mintLinksBatch` always generates a `CODE_LENGTH`-character (7) code (`customAlphabet(CODE_ALPHABET, CODE_LENGTH)` in `lib/links/mint-link.ts`) and every recipient in a stage shares the same `shortDomain` (resolved once, before the per-recipient loop) — so `https://${domain}/r/${code}` has identical length for every recipient in a stage. `creativeText`, `brandName`, and `stopText` are all stage-level (no per-recipient interpolation in `buildStageSms`). In manual mode, `linkUrl` is the single pasted `short_url`, also stage-level. Therefore one representative segment count, computed once before recipient enumeration, is accurate for the whole stage — no per-recipient variance to reconcile.

- [ ] **Step 1: Export `CODE_LENGTH` from `lib/links/mint-link.ts`**

In `lib/links/mint-link.ts` (~line 42), change:

```ts
const CODE_LENGTH = 7;
```

to:

```ts
export const CODE_LENGTH = 7;
```

- [ ] **Step 2: Write the failing test** — `scripts/test-kickoff-segments.ts`

```ts
// G8 + spec §4: kickoff refuses a stage whose rendered text (creative + brand
// prefix + tracked link + stop text) crosses into multi-segment territory
// unless the creative opts in (allow_multi_segment=true) — and refuses ANY
// text over MAX_SEGMENTS regardless of that override (the ceiling, G8).
// Mirrors scripts/test-kickoff-fullurl.ts's fixture recipe. Rolled-back tx.
// Run: npx tsx scripts/test-kickoff-segments.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { kickoffStageSend } from "@/lib/sends/kickoff";
import { MAX_SEGMENTS } from "@/lib/sends/segments";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

async function main() {
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const org = await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
      const orgId = org.id;
      const brand = await one<{ id: number }>(sql`
        SELECT b.id FROM brands b
        JOIN short_domains sd ON sd.brand_id = b.id AND sd.status = 'active'
        WHERE b.org_id = ${orgId} LIMIT 1`);
      if (!brand) { console.log("SKIP: need a brand with an active short domain"); throw ROLLBACK; }

      const prov = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"kseg-" + sfx}, ${orgId}, ${"kseg"}, true) RETURNING id`);
      await tx.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key) VALUES (${orgId}, ${prov.id}, NULL, ${"k"})`);

      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, tracking_id)
        VALUES (${orgId}, ${"kseg-camp-" + sfx}, ${"kseg"}, 'active', 'tracked', ${brand.id}, ${"9_99_kseg_" + sfx}) RETURNING id`);
      const campaignId = camp.id;

      // Build one stage per case: a fresh creative + contact + audience-pool
      // row + stage, so each case's kickoff runs against an UNmaterialized
      // stage (materialized_at gates a re-run to a no-op, so cases can't
      // share a stage). full_url is set directly (Bug-3 pattern from
      // test-kickoff-fullurl.ts) so kickoff doesn't need an offer/sales-page.
      async function mkCase(opts: { n: number; text: string; allowMultiSegment: boolean }) {
        const cre = await one<{ id: number }>(sql`
          INSERT INTO creatives (slug, org_id, text, status, allow_multi_segment)
          VALUES (${"kseg-cre-" + sfx + "-" + opts.n}, ${orgId}, ${opts.text}, 'active', ${opts.allowMultiSegment})
          RETURNING id`);
        const trackingId = `9_99_kseg_${sfx}_s${opts.n}`;
        const fullUrl = `https://www.guidekn.com/lp/knd?sub_id3=${trackingId}`;
        const stage = await one<{ id: number }>(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, creative_id, sms_provider_id, send_approved,
             tracking_id, full_url, include_no_status, stop_text, scheduled_at)
          VALUES (${orgId}, ${campaignId}, ${opts.n}, ${cre.id}, ${prov.id}, true,
             ${trackingId}, ${fullUrl}, true, ${"STOP"}, now())
          RETURNING id`);
        const contact = await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1555" + sfx + opts.n}) RETURNING id`);
        await tx.execute(sql`
          INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot)
          VALUES (${orgId}, ${campaignId}, ${contact.id}, true, false)`);
        return stage.id;
      }

      // Case A: short text, override off -> 1 segment, sends fine.
      const stageA = await mkCase({ n: 1, text: "Hi", allowMultiSegment: false });
      const resA = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId: stageA });
      check("short text (1 segment) sends regardless of the override", resA.ok, JSON.stringify(resA));

      // Case B: long text (2 segments, well under the ceiling), override OFF -> refused.
      const stageB = await mkCase({ n: 2, text: "A".repeat(200), allowMultiSegment: false });
      const resB = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId: stageB });
      check(
        "multi-segment text refused when the creative's override is off",
        !resB.ok && resB.reason === "multi_segment_not_allowed",
        JSON.stringify(resB),
      );

      // Case C: same long text, override ON -> allowed.
      const stageC = await mkCase({ n: 3, text: "A".repeat(200), allowMultiSegment: true });
      const resC = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId: stageC });
      check("same multi-segment text sends once the creative's override is on", resC.ok, JSON.stringify(resC));

      // Case D: extreme text (over MAX_SEGMENTS), override ON -> STILL refused (G8 ceiling).
      const stageD = await mkCase({ n: 4, text: "A".repeat(800), allowMultiSegment: true });
      const resD = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId: stageD });
      check(
        `text over ${MAX_SEGMENTS} segments is refused even with the override on (G8 ceiling)`,
        !resD.ok && resD.reason === "segment_ceiling_exceeded",
        JSON.stringify(resD),
      );

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx scripts/test-kickoff-segments.ts`
Expected: FAIL — `resB`/`resD` currently succeed (`ok: true`) because there's no segment gate yet; `KickoffRefusal` doesn't have the two new reasons.

(If it prints `SKIP: need a brand with an active short domain`, run against an environment that has one — same precondition `test-kickoff-fullurl.ts` already depends on.)

- [ ] **Step 4: Add the two refusal reasons to `KickoffRefusal`**

In `lib/sends/kickoff.ts` (~line 45-59), replace:

```ts
export type KickoffRefusal =
  | "not_found"
  | "no_creative"
  | "no_schedule"
  | "no_recipients"
  // tracked-only:
  | "stage_not_ready"
  | "no_provider"
  | "provider_not_api_capable"
  | "no_credentials"
  | "no_short_domain"
  | "no_destination"
  // The resolved destination is a malformed guidekn URL — refuse rather than
  // ship a 404 that silently loses attribution.
  | "invalid_destination";
```

with:

```ts
export type KickoffRefusal =
  | "not_found"
  | "no_creative"
  | "no_schedule"
  | "no_recipients"
  // tracked-only:
  | "stage_not_ready"
  | "no_provider"
  | "provider_not_api_capable"
  | "no_credentials"
  | "no_short_domain"
  | "no_destination"
  // The resolved destination is a malformed guidekn URL — refuse rather than
  // ship a 404 that silently loses attribution.
  | "invalid_destination"
  // Rendered text (creative + brand prefix + tracked link + stop text)
  // exceeds 1 SMS segment and the creative hasn't opted in
  // (allow_multi_segment=false). Spec §4.
  | "multi_segment_not_allowed"
  // G8 hard ceiling: text exceeds MAX_SEGMENTS regardless of the creative's
  // allow_multi_segment override — never runaway multipart.
  | "segment_ceiling_exceeded";
```

- [ ] **Step 5: Add `creative_allow_multi_segment` to `MainRow` + the SELECT**

In `lib/sends/kickoff.ts`, add to the `MainRow` interface (~line 74-99), after `creative_text: string | null;`:

```ts
  creative_allow_multi_segment: boolean;
```

And add to the SQL SELECT (~line 136, alongside `cr.text AS creative_text`):

```sql
      cr.text                    AS creative_text,
      cr.allow_multi_segment     AS creative_allow_multi_segment,
```

- [ ] **Step 6: Add imports**

At the top of `lib/sends/kickoff.ts`, add:

```ts
import { CODE_LENGTH } from "@/lib/links/mint-link";
import { countSegments, MAX_SEGMENTS } from "@/lib/sends/segments";
```

- [ ] **Step 7: Insert the segment preflight gate**

Immediately after the closing brace of the `if (mode === "manual") { … } else { … }` block (~line 256, right before the `// ---- Enumerate the recipients …` comment at ~line 258), insert:

```ts
  // ---- Segment policy preflight (G8 + spec §4). Rendered text is
  // recipient-invariant WITHIN a stage — see the plan's design note — so one
  // representative count is accurate for every recipient. Checked BEFORE any
  // recipient enumeration/materialization so a misconfigured creative refuses
  // cheaply, same pattern as the mode-specific guards above.
  const representativeText =
    mode === "manual"
      ? manualText
      : buildStageSms({
          brandName,
          creativeText: row.creative_text,
          linkUrl: `https://${shortDomain!.domain}/r/${"X".repeat(CODE_LENGTH)}`,
          stopText: row.stop_text,
        });
  const segCheck = countSegments(representativeText);
  if (segCheck.segments > MAX_SEGMENTS) {
    return { ok: false, reason: "segment_ceiling_exceeded" };
  }
  if (segCheck.segments > 1 && !row.creative_allow_multi_segment) {
    return { ok: false, reason: "multi_segment_not_allowed" };
  }
```

- [ ] **Step 8: Add messages to `KICKOFF_REFUSAL`**

In `lib/sends/kickoff-refusals.ts`, add the import and the two entries:

```ts
import { MAX_SEGMENTS } from "@/lib/sends/segments";
import type { KickoffRefusal } from "@/lib/sends/kickoff";
```

Add to the `KICKOFF_REFUSAL` record (after `invalid_destination`):

```ts
  multi_segment_not_allowed: {
    status: 400,
    message:
      'This message renders to more than 1 SMS segment — turn on "Allow multi-segment" on the creative to send it, or shorten the text',
  },
  segment_ceiling_exceeded: {
    status: 400,
    message: `This message renders to more than ${MAX_SEGMENTS} SMS segments — shorten the text (even multi-segment creatives can't exceed this)`,
  },
```

- [ ] **Step 9: Add the two refusals to `scheduled.ts`'s `PERMANENT_REFUSALS`**

Mirrors Section 1 Task 3's precedent (the drain's `unknown_provider` was added to 2 route-level refusal maps). In `lib/sends/scheduled.ts` (~line 204-215), add both new refusals to the `PERMANENT_REFUSALS` set — a stage refused this way won't self-resolve within the scheduled window (a human must edit the creative), same category as `no_creative`/`no_short_domain`:

```ts
const PERMANENT_REFUSALS: ReadonlySet<KickoffRefusal> = new Set([
  "not_found",
  "no_creative",
  "no_schedule",
  "no_recipients",
  "stage_not_ready",
  "no_provider",
  "provider_not_api_capable",
  "no_credentials",
  "no_short_domain",
  "no_destination",
  "multi_segment_not_allowed",
  "segment_ceiling_exceeded",
]);
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx tsx scripts/test-kickoff-segments.ts`
Expected: PASS — `ALL PASS (rolled back).`, exit 0.

- [ ] **Step 11: Run the full regression set + typecheck**

Run: `npx tsx scripts/test-kickoff-fullurl.ts && npx tsx scripts/verify-drain.ts && npx tsc --noEmit`
Expected: all PASS, no type errors (confirms the exhaustive `KICKOFF_REFUSAL` record compiles with the two new keys and nothing else regressed).

- [ ] **Step 12: Update `docs/04-features/sms-send-pipeline.md`**

Add a subsection (near the existing send-path "How it works" narrative) describing the segment preflight gate: single-segment default, `allow_multi_segment` override, `MAX_SEGMENTS` hard ceiling (G8), and that it applies to both manual and tracked modes uniformly since rendered text is recipient-invariant per stage. Link to `docs/07-conventions.md`'s G8 entry (Task 3) rather than duplicating the ceiling rationale.

- [ ] **Step 13: Append to `docs/CHANGELOG.md`**

```
## 2026-07-15 — Kickoff segment preflight gate (multi_segment_not_allowed / segment_ceiling_exceeded, Section 2 Task 5) — docs/04-features/sms-send-pipeline.md
```

- [ ] **Step 14: Commit**

```bash
git add lib/links/mint-link.ts lib/sends/kickoff.ts lib/sends/kickoff-refusals.ts lib/sends/scheduled.ts scripts/test-kickoff-segments.ts docs/04-features/sms-send-pipeline.md docs/CHANGELOG.md
git commit -m "feat(ahoi): enforce segment policy at kickoff preflight (G8 ceiling + per-creative override)"
```

---

## Task 6: Creative form advisory UI

**Files:**
- Modify: `lib/validators/creatives.ts`, `components/creatives/creative-form.tsx`
- Modify: `app/api/creatives/route.ts`, `app/api/creatives/[id]/route.ts`, `app/(protected)/creatives/page.tsx`
- Modify: `docs/04-features/campaigns-stages-creatives.md`

No new test script — this is UI/plumbing wired to code already proven correct (Task 3's `countSegments`/`MAX_SEGMENTS`, Task 4's column, Task 5's gate). Verified via `npx tsc --noEmit` (the form/route/page all type-check against the Zod schema and the DB column) plus a manual click-through (Step 8).

**Interfaces:**
- Consumes: `MAX_SEGMENTS` (Task 3); `creatives.allow_multi_segment` (Task 4, applied).
- Produces: the creative form persists `allow_multi_segment`; advisory-only — a multi-segment creative can still be **saved** (the hard gate is Task 5's kickoff check, not form submit).

- [ ] **Step 1: Add `allow_multi_segment` to the Zod validators**

In `lib/validators/creatives.ts`, add to `creativeCreateSchema`'s object (after `applies_to_all_offers`):

```ts
    applies_to_all_offers: z.boolean().default(false),
    allow_multi_segment: z.boolean().default(false),
```

And to `creativeUpdateSchema`'s object (after `applies_to_all_offers`):

```ts
    applies_to_all_offers: z.boolean().optional(),
    allow_multi_segment: z.boolean().optional(),
```

- [ ] **Step 2: Wire the create route**

In `app/api/creatives/route.ts`, `handleSingle`'s insert `.values({...})` (~line 103-113), add after `applies_to_all_offers: input.applies_to_all_offers,`:

```ts
            allow_multi_segment: input.allow_multi_segment,
```

`loadCreativeWithOffers`'s select (~line 270-289) — add after `applies_to_all_offers: creatives.applies_to_all_offers,`:

```ts
      allow_multi_segment: creatives.allow_multi_segment,
```

(`handleBulk`'s insert is intentionally left untouched — bulk-create has no per-row or shared `allow_multi_segment` input in this task's scope; new bulk-created rows get the column's DB default of `false`, which is correct since Ahoi's Section 2 scope only asked for the single create/edit form.)

- [ ] **Step 3: Wire the `[id]` GET route select**

In `app/api/creatives/[id]/route.ts`, the `GET` handler's select (~line 66-85), add after `applies_to_all_offers: creatives.applies_to_all_offers,`:

```ts
      allow_multi_segment: creatives.allow_multi_segment,
```

No change needed to `PATCH` — its update-builder (~line 220-225) already generically copies any defined key from the parsed input into the DB update, so adding the field to `creativeUpdateSchema` (Step 1) is sufficient.

- [ ] **Step 4: Update the creative form component**

In `components/creatives/creative-form.tsx`:

Add the import (alongside the existing `calculateSmsSegments` import):

```ts
import { MAX_SEGMENTS } from "@/lib/sends/segments";
```

Add to `formSchema` (after `applies_to_all_offers: z.boolean(),`):

```ts
  allow_multi_segment: z.boolean(),
```

Add to the `useForm` `defaultValues` (after `applies_to_all_offers: initialValues?.applies_to_all_offers ?? false,`):

```ts
      allow_multi_segment: initialValues?.allow_multi_segment ?? false,
```

Add a watcher (alongside the existing `appliesToAll` watcher):

```ts
  const allowMultiSegment = form.watch("allow_multi_segment");
```

Replace the hardcoded ceiling literal in `counterTone` (~line 213-217) with the imported constant — same behavior today (`MAX_SEGMENTS === 4`), single source of truth going forward:

```ts
  const counterTone = isLongText
    ? "text-red-700 dark:text-red-400"
    : segments.segments > MAX_SEGMENTS
      ? "text-amber-700 dark:text-amber-400"
      : "text-muted-foreground";
```

Add a segment-policy warning inside the `text` `FormField`'s render, immediately after the existing `hasEmDash` `FormDescription` block (~line 285-297) and before `<SpamCheckStrip …/>`:

```tsx
              {segments.segments > MAX_SEGMENTS ? (
                <FormDescription className="flex items-start gap-1.5 text-red-700 dark:text-red-400">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    Exceeds the hard limit of {MAX_SEGMENTS} segments — this
                    will be refused at send no matter what. Shorten the text.
                  </span>
                </FormDescription>
              ) : segments.segments > 1 && !allowMultiSegment ? (
                <FormDescription className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    Renders to {segments.segments} segments. Turn on &quot;Allow
                    multi-segment&quot; below to send this, or shorten the text
                    to fit 1 segment.
                  </span>
                </FormDescription>
              ) : null}
```

Add the toggle as a new block, after the "Apply to all offers" block (~line 313-378) and before the quality/sequence/funnel-stage grid (~line 380):

```tsx
        <div className="grid gap-3 rounded-md border p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label className="cursor-pointer" htmlFor="allow-multi-segment">
                Allow multi-segment
              </Label>
              <p className="text-xs text-muted-foreground">
                Off (default): this creative is refused at send if it renders
                to more than 1 SMS segment. On: allows up to {MAX_SEGMENTS}{" "}
                segments — never more, a hard limit.
              </p>
            </div>
            <FormField
              control={form.control}
              name="allow_multi_segment"
              render={({ field }) => (
                <Switch
                  id="allow-multi-segment"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={isSubmitting}
                />
              )}
            />
          </div>
        </div>
```

- [ ] **Step 5: Wire the creatives list page**

In `app/(protected)/creatives/page.tsx`:

Add to the `Creative` type (~line 92-104), after `applies_to_all_offers: boolean;`:

```ts
  allow_multi_segment: boolean;
```

Add to `handleEdit`'s PATCH body (~line 675-683), after `applies_to_all_offers: values.applies_to_all_offers,`:

```ts
      allow_multi_segment: values.allow_multi_segment,
```

Add to the edit-dialog `<CreativeForm>`'s `initialValues` (~line 1285-1293), after `applies_to_all_offers: editing.applies_to_all_offers,`:

```ts
              allow_multi_segment: editing.allow_multi_segment,
```

(`CreativeForm`'s `mode="create"` path exists in the component but has no consumer on this page today — single-creative creation isn't wired anywhere; `BulkCreativeForm` is the only creation path. This is pre-existing and out of scope here.)

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the full regression set**

Run: `npx tsx scripts/test-kickoff-segments.ts && npx tsx scripts/test-segments.ts && npx tsx scripts/test-ahoi-send.ts && npx tsx scripts/test-drain-sender-number.ts && npx tsx scripts/verify-drain.ts`
Expected: all PASS.

- [ ] **Step 8: Manual verification (dev server)**

Start the dev server, open the creatives page, edit an existing creative:
- Type a message over 160 GSM-7 characters (no override) → confirm the amber "Renders to N segments…" warning appears and the form still allows Save.
- Toggle "Allow multi-segment" on, save, reopen the edit dialog → confirm the toggle persisted as on.
- Type a message over `4 * 153` characters → confirm the red "Exceeds the hard limit…" warning appears regardless of the toggle state.

- [ ] **Step 9: Update `docs/04-features/campaigns-stages-creatives.md`**

In the `### Creatives` section (~line 60-71), add a bullet: "`allow_multi_segment` (migration `0108`, default `false`) — per-creative override for the send-path segment gate (see `docs/07-conventions.md` G8 and `docs/04-features/sms-send-pipeline.md`). Advisory-only in the creative form (a multi-segment creative can be saved); the hard gate is at kickoff, not save."

- [ ] **Step 10: Append to `docs/CHANGELOG.md`**

```
## 2026-07-15 — Creative form: allow_multi_segment toggle + segment warnings (Section 2 Task 6) — docs/04-features/campaigns-stages-creatives.md
```

- [ ] **Step 11: Commit**

```bash
git add lib/validators/creatives.ts components/creatives/creative-form.tsx app/api/creatives/route.ts app/api/creatives/[id]/route.ts "app/(protected)/creatives/page.tsx" docs/04-features/campaigns-stages-creatives.md docs/CHANGELOG.md
git commit -m "feat(ahoi): creative form allow_multi_segment toggle + live segment warnings (advisory)"
```

---

## Section 2 Checkpoint

Stop here and bring back for review before Section 3 (DLR + CDR intake). Deliverables:
- Ahoi `send()`/`buildRedactedRequest()` real, classifying off the always-200 body; TextHub's send path unaffected (`verify-drain` green).
- `stage.sender_number` flows from `provider_phones.phone_number` through the drain into `adapter.send` and the redacted audit log.
- Segment counting (`lib/sends/segments.ts`) wraps the existing GSM-7/UCS-2 implementation; `MAX_SEGMENTS = 4` (G8) is the single source of truth.
- `creatives.allow_multi_segment` column live (migration 0108, applied only after explicit user go-ahead).
- Kickoff refuses (`multi_segment_not_allowed` / `segment_ceiling_exceeded`) before any recipient materialization when the segment policy is violated; `scheduled.ts` treats both as permanent (non-retrying) refusals.
- Creative form surfaces the policy live (advisory only — save is never blocked).
- `SEND_ENABLED` still off; no Ahoi send code path is reachable from a live cron/drain trigger yet beyond what Section 1 already wired (unknown_provider guard remains for any provider without an adapter, N/A here since ahoi is now fully registered).

---

## Self-Review

**Spec coverage (§4 + G8):**
- Ahoi `send()` POST `/sms/send`, form body `key/source/destination/message`, always-200 body classification (`{status:"ok",uuid}` → accepted; `{status:"error",error}` → theirs_rejected; network/timeout → status 0) → Task 1 ✓, verified against the **unchanged** `classifyAttempt` in the test itself (not just asserted by inspection).
- Circuit breakers unchanged (they read `sms_providers`/`stage_sends` generically, no Ahoi-specific code touched) — correctly out of this plan's Task list.
- `senderNumber` wiring with G2 regression proof → Task 2 ✓ (`verify-drain.ts` re-run as a required step, not optional).
- Segment counting (GSM-7 160/153, UCS-2 70/67) + `MAX_SEGMENTS=4` → Task 3 ✓, wrapping the existing implementation rather than forking it (a deliberate, justified deviation from the brief's literal "GSM-7 detection… UCS-2 detection…" wording — see the design note below).
- `creatives.allow_multi_segment` migration, hand-authored, hard user gate → Task 4 ✓.
- Kickoff hard gate: `multi_segment_not_allowed` (>1 segment, override off) and `segment_ceiling_exceeded` (>`MAX_SEGMENTS`, **regardless** of override) → Task 5 ✓, both proven by a 4-case DB test (1-segment always-allowed, multi-segment-blocked-by-default, multi-segment-allowed-by-override, ceiling-blocks-even-with-override).
- Cost multiplication by segment count in estimates (spec §4 "Cost" bullet) is **not** in this plan — it wasn't named in the Section 2 task brief's two workstreams (A: send path, B: schema/counting/kickoff/form), and no existing cost-estimate call site was identified during recon as needing this wiring. Flagged as a gap for the user to confirm is deferred (see Return notes), not silently dropped.
- Advisory creative-form UI (live indicator + toggle, save never blocked) → Task 6 ✓.

**Placeholder scan:** every task's code block is complete and copy-pasteable — no `TBD`, no `// ...`, no elided function bodies. Task 4's Steps 7-8 are an explicit STOP/gate (not a placeholder — the SQL, snapshot diff, and journal entry are fully written; only the `db:migrate` invocation itself is withheld pending user approval, mirroring Section 1 Task 4's precedent exactly).

**Type consistency:** `NormalizedSendParams.senderNumber: string | null` (Section 1) is threaded unchanged through `Sender`'s new optional `senderNumber?: string | null` (Task 2) — the `?? null` normalization in `resolveSenderForStage`'s closure is the only coercion point. `SegmentCount { encoding, chars, segments }` (Task 3) is consumed identically by `kickoff.ts` (Task 5) and `creative-form.tsx` (Task 6) — no shape drift. `KickoffRefusal`'s two new members are exhaustively required by `KICKOFF_REFUSAL: Record<KickoffRefusal, …>` (TypeScript enforces this at compile time — Step 11 of Task 5 typechecks it), and additionally added to `PERMANENT_REFUSALS: ReadonlySet<KickoffRefusal>` (not compiler-enforced since it's a Set, so this was a deliberate carry-forward from the Section-1-Task-3 precedent, not an accident).

**Reuse discipline:** `lib/sends/segments.ts` wraps `lib/creative-helpers.ts`'s `calculateSmsSegments` rather than reimplementing GSM-7/UCS-2 detection — that function is already live in **two** existing UI surfaces (`creative-form.tsx`'s inline counter, `creative-picker-dialog.tsx`'s warning badges), so a third independent implementation would risk the send-path gate silently diverging from what an operator sees on screen. This is flagged explicitly in the Return notes as a deviation from the brief's literal task description worth surfacing, even though it's a strict simplification with no behavior change.

**The three CARRIES from the brief, explicitly resolved:**
1. **G8 ceiling** — `MAX_SEGMENTS = 4` constant, single location (`lib/sends/segments.ts`), enforced in `kickoff.ts` unconditionally (checked before, and independent of, the `allow_multi_segment` override check) — Task 3 + Task 5.
2. **senderNumber query change + G2 proof** — `pp.phone_number AS sender_number` added to the existing `provider_phones` join (no new join); `Sender`'s new field is optional so `verify-drain.ts`'s injected fakes need zero edits; `verify-drain.ts` is re-run as a mandatory step (not just typechecked) — Task 2. Also fixed the redaction call site's hardcoded `senderNumber: null`, which the brief didn't explicitly name but which the same G2/audit-accuracy intent requires.
3. **`texthub_message_id` naming-debt flag** — carried forward verbatim as a note (not fixed — explicitly out of scope for Section 2 per the brief): `stage_sends.texthub_message_id` (`lib/sends/drain.ts:436`) stores whatever `messageId` the adapter returns, so an Ahoi send's `uuid` lands in a column named after TextHub. Renaming it is deferred to Section 3, where DLR reconciliation keys off this column and Ahoi's multi-segment sends emit extra DLRs under numeric uuids that won't match the send-time `s-…` uuid — the column's contents (not just its name) become directly relevant there.
