# TextHub sender selection (`sender` parameter) — Design

**Date:** 2026-07-22
**Status:** Approved (brainstorming complete; ready for implementation plan)
**Author:** Claude + Demian

## 1. Problem

TextHub's outbound send API now accepts a `sender` parameter that selects which
of the account's numbers a message is sent from:

```
GET https://api.texthub.com/v2/?api_key=...&number=<recipient>&text=...&sender=<SENDER_ID>
```

Per TextHub support, `sender` is **the sending phone number itself, with no
country code**:

- **10DLC** and **toll-free (TFN)** numbers → the 10-digit national number
  (e.g. `+19175551234` → `9175551234`).
- **Short codes** → the 5–6 digit code as-is (no country code to strip).
- `sender` is **optional** to TextHub — if omitted, TextHub uses the account's
  default sender.

CamMan already lets each stage pick a provider phone (`provider_phone_id`), but
the TextHub adapter discards it. We want CamMan to send from the selected number,
add a campaign-level default to reduce clicks, and guarantee a deliberate sender
(no silent fallback to the account default).

## 2. What already exists (no change needed)

- **Stage phone picker.** `components/campaigns/stage-form.tsx` has a "Phone
  number" `Select` bound to `provider_phone_id`, filtered to the stage's
  provider, auto-selecting when a provider exposes exactly one active phone.
- **Sender threading.** `lib/sends/drain.ts` resolves the stage's
  `provider_phone_id` to `provider_phones.phone_number` (E.164) as
  `sender_number`, and passes it to the adapter as `NormalizedSendParams.senderNumber`.
- **Ahoi precedent.** `lib/sends/providers/ahoi.ts` already consumes
  `senderNumber` as its `source` and refuses (never throws) when it is missing.
- **TextHub adapter ignores it.** `lib/sends/providers/texthub.ts` drops
  `senderNumber` entirely — this is the gap.

## 3. Design

Three parts. Only Part 2 needs a migration.

### Part 1 — Emit the `sender` parameter (the core ask)

**`lib/sends/texthub.ts`:**

- Add optional `sender?: string | null` to `SendSmsParams`.
- In `buildSendUrl`, set it only when present:
  `if (params.sender) url.searchParams.set("sender", params.sender);`
  (Keep the existing invariants: never set `long_url`, never set `group`.)
- Add a pure, tsx-safe helper `toTexthubSender(e164: string): string` that strips
  the US country code → 10 digits and passes short codes through unchanged.
  **No `libphonenumber`** — it throws under `tsx`, which is why Ahoi hand-rolled
  `toAhoiRecipient`; the logic is identical:
  - strip non-digits; if 11 digits starting with `1`, drop the leading `1` → 10
    digits; otherwise return the digits as-is (covers 5–6 digit short codes and
    already-national numbers).
  - US-only assumption (all TextHub numbers are 10DLC / TFN / short code).
    Documented; revisit only if non-US sending numbers are added.

**`lib/sends/providers/texthub.ts`:**

- **Refuse on a null sender, mirroring Ahoi.** Because the user chose to *block*
  rather than fall back to TextHub's account default, `send()` returns a clean
  `ok: false` (no network call, `status: 0`, `timedOut: false`) when
  `p.senderNumber` is null — the same shape `ahoiAdapter.send` already returns.
  This is the deepest backstop; the kickoff gate (Part 3) blocks earlier.
- When a sender is present, compute `sender = toTexthubSender(p.senderNumber)` and
  pass it to `rawSendSms` / `buildSendUrl` in both `send()` and
  `buildRedactedRequest()`. Include `sender` in the redacted audit string too, so
  `send_attempts` reflects the real request (audit-accuracy principle from Ahoi).

No drain change (senderNumber already threaded). No schema change for Part 1.

### Part 2 — Campaign-level default sender (prefill convenience)

Because there is **no campaign-level provider** — provider and phone both live on
each stage — a campaign default cannot *be* "the campaign's sender." It is a
**prefill convenience**, not a send-time fallback.

- **Migration 0115:** add `campaigns.default_provider_phone_id integer`, nullable,
  `REFERENCES provider_phones(id) ON DELETE SET NULL`. Hand-authored per project
  convention (`db:generate` blocks); applied to the shared prod `DATABASE_URL`
  before the dependent code ships; verify with `verify-migration-integrity.ts`.
- **Campaign form + API:** add a "Default send-from number" picker listing the
  org's **active** phones across all providers (labeled by provider). Optional.
  Needs a list of active phones for the org — a small `GET` endpoint (or reuse of
  an existing list) returning `{ id, phone_number, provider label }`; exact source
  is a plan detail.
- **Stage prefill:** when a **new** stage is created under a campaign that has a
  `default_provider_phone_id`, pre-fill the stage's provider + phone from that
  default. Operator can override per stage. Reuses the existing "auto-select
  single phone" convenience path in `stage-form.tsx`.
- **Send-time resolution is unchanged and stage-only.** The drain keeps reading
  `stage.provider_phone_id`. No inheritance, no fallback, no provider-mismatch
  validation. A stage with no phone does **not** inherit the campaign default at
  send time (see Part 3 — it is blocked instead).

### Part 3 — Block sends with no sender

Uniform rule: **any API-send (tracked) stage must have a phone assigned.** The
mechanism **already exists** — the kickoff gate refuses with `no_sender_number`,
but is currently narrowed to Ahoi. We generalize it.

- **`lib/sends/kickoff.ts` (~line 227):** the existing guard reads
  `if (provider[0].provider_key === "ahi" && row.provider_phone_id == null)`.
  This check sits *after* the `supports_api_send` gate (line 219), so it only ever
  runs for API-capable providers. **Drop the `provider_key === "ahi"` clause** →
  `if (row.provider_phone_id == null) return { ok: false, reason: "no_sender_number" };`
  Now every API-send stage (TextHub `txh`/`txh2`, Ahoi `ahi`, any future) is
  blocked without a phone. The operator message already exists in
  `lib/sends/kickoff-refusals.ts` (`no_sender_number`). This gate only applies to
  `link_mode='tracked'` stages — manual stages don't call a provider API, so they
  are correctly untouched.
- **`lib/sends/preflight.ts`:** the read-only UI checklist has **no** sender check
  today. Add `"no_sender_number"` to `PreflightBlocker` and, in the tracked
  branch, `add("sender", row.provider_phone_id != null, "Sending number assigned",
  "no_sender_number")`. `provider_phone_id` is already selected by preflight's
  query. This makes the blocker show red in the Prepare/readiness UI before send.
- **Adapter backstop:** the TextHub adapter's refuse-on-null (Part 1) is the last
  line of defense for the rare "phone cleared after materialization" window.
- **No Ahoi regression:** Ahoi already hit this gate; generalizing the condition
  leaves its behavior identical.

## 4. Pre-deploy safety (live sends)

Sends are live in production. Before deploying Part 3, run a **read-only audit**
of currently-active TextHub stages missing a phone, so no in-flight campaign is
stranded by the new block:

- Count `campaign_stages` where the stage is on a live campaign
  (`status='active'`), the provider is an API-send provider (TextHub today), and
  `provider_phone_id IS NULL`.
- If the count is > 0, surface it to the user and assign phones **before** the
  block ships. If 0, the block is safe to deploy directly.

## 5. Testing / verification

- **`scripts/test-texthub-send.ts`** (new, tsx, plain `check()` harness like
  `scripts/test-ahoi-send.ts`): asserts
  - `+19175551234` → URL contains `sender=9175551234`;
  - a short code (e.g. `12345`) passes through as `sender=12345`;
  - `senderNumber: null` → `send()` returns `ok:false` with **no** network call
    (refuse-on-null, mirroring Ahoi);
  - the redacted audit string includes the same `sender` and never the raw key.
- **`scripts/verify-drain.ts`** re-run: proves the optional `sender` field and the
  adapter change cause no regression in the injected-seam path.
- Typecheck / lint clean.

## 6. Files touched

- `lib/sends/texthub.ts` — `sender` on `SendSmsParams` + `buildSendUrl`; new
  `toTexthubSender`.
- `lib/sends/providers/texthub.ts` — refuse-on-null + thread `sender` through
  `send` + redaction.
- `lib/sends/kickoff.ts` — generalize the `no_sender_number` guard (drop the
  `=== "ahi"` clause).
- `lib/sends/preflight.ts` — add the `no_sender_number` blocker + checklist item.
- `db/schema.ts` + `db/migrations/0115_*.sql` + `meta/0115_snapshot.json` +
  `meta/_journal.json` — `campaigns.default_provider_phone_id`.
- `lib/validators/campaigns.ts` — `default_provider_phone_id` on create/update.
- `app/api/campaigns/route.ts` + `app/api/campaigns/[campaignId]/route.ts` —
  insert/select/FK-verify the new column.
- New `app/api/provider-phones/list/route.ts` — org-wide active phones (labeled by
  provider) for the campaign picker (gated `provider_phones.view`).
- `components/campaigns/campaign-form-state.ts` + `campaign-form-fields.tsx` —
  default-sender picker + phones fetch + form value/default.
- `components/campaigns/stage-form.tsx` — prefill provider+phone from the
  campaign default on new-stage create.
- `scripts/test-texthub-send.ts` (new).
- Docs: `03-data-model.md` (+ ERD), `04-features/` (campaigns / sends),
  `06-integrations.md` (TextHub `sender` param), `07-conventions.md`
  (sender = national digits), `CHANGELOG.md`.

## 7. Explicitly out of scope

- Resolve/inherit-at-send-time for the campaign default (rejected in favor of
  prefill — avoids provider-mismatch validation).
- A dedicated per-phone "TextHub sender token" column (`sender` is derived from
  the stored number, so none is needed).
- Non-US sending numbers.
- Activation-time (draft→active) blocking — send-time preflight only.
- Any change to Ahoi behavior.

## 8. Decisions (confirmed with user)

- `sender` value = the phone number **without country code** (10 digits for
  TFN/10DLC; short code as-is).
- Campaign default = **prefill new stages** (not send-time inheritance).
- Missing sender = **blocked** at the **kickoff send gate** (generalizing the
  existing `no_sender_number` guard) + shown in the read-only preflight checklist,
  plus a pre-deploy audit. Not at draft→active activation.
- Stage "Phone number" label left unchanged (no copy change).
