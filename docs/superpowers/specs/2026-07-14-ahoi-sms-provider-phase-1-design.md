# Ahoi SMS Provider — Phase 1 Foundation Design

**Date:** 2026-07-14
**Status:** Design approved (all 4 sections), pending spec review → implementation plan
**Phase 0 recon:** complete & signed off. Findings of record: `.claude/projects/c--AFF-camman/memory/project_ahoi_provider_recon.md`

---

## 1. Context & Scope

Integrate **Ahoi** (a white-label of the api19 / CallAPI platform, base `https://v1.api19.com`) as a **second** SMS provider alongside TextHub, reusing CamMan's existing provider/send/suppression machinery. The codebase was built anticipating provider #2 (see the "until provider #2" comments in `db/schema.ts` circuit-breaker notes).

**Foundation-first ordering** (build + checkpoint each before the next):
1. Numbers model + adapter skeleton
2. Send path (+ segment policy)
3. DLR + CDR intake
4. Opt-out intake (3 layers) + go-live gate

**Hard constraints:**
- `SEND_ENABLED` stays **OFF** for the entire phase. Go-live is a separate, gated step (§6).
- **Do not disturb TextHub's proven send/suppression path.** Additions are Ahoi-specific; shared code is touched only where explicitly noted.
- No per-recipient delivery-status tracking (deferred — see §8).

**Phase 0 facts that drive the design:**
- Auth = `key` query/body param (not a header/Bearer). Base URL from `AHOI_API_BASE_URL`.
- Platform **always returns HTTP 200**; real result is the body `status` field.
- Numbers are **10-digit, no `+1`**, both directions.
- DLR carries undocumented `smpp_code`/`smpp_status`; real spelling is `DELIVRD` in `smpp_status` (lowercase `delivered` in `status`). Multi-segment sends emit **extra DLRs under numeric uuids** that don't match the send `s-…` uuid.
- Portal "Enforce GSM/160" settings do nothing — Ahoi silently sends Unicode + splits >160 into billed segments.
- Inbound webhook is reliable for what Ahoi receives (0% webhook-layer loss measured); ~50% observed loss was **upstream carrier** loss, unrecoverable by any ingestion method. `/cdrs/download/csv?record_type=sms` is an **ungated pollable system-of-record** (columns incl. `direction=in/out`).
- Ahoi enforces **no** opt-out suppression on its side — CamMan owns suppression end-to-end.

---

## 2. Architecture Decision — Provider adapter registry (Approach A)

Introduce a thin provider-adapter seam. Today the send path is TextHub-shaped: `drain.ts` injects a `Sender` defaulting to TextHub's `sendSms`; `SendSmsResult` is already a normalized shape, but the param shape and `buildSendUrl` are TextHub-specific and provider selection at the drain doesn't exist.

**New module `lib/sends/providers/`:**
- `types.ts` — the interface + normalized types:
  ```ts
  interface SmsProviderAdapter {
    key: "texthub" | "ahoi";                 // === sms_providers.sms_provider_id
    send(p: NormalizedSendParams): Promise<SendSmsResult>;
    buildRedactedRequest(p: NormalizedSendParams): string;  // feeds send_attempts audit log
    toProviderRecipient(e164: string): string;              // E.164 → provider format
    parseDlr(raw: RawWebhook): DlrEvent | null;             // provider-specific → normalized
    parseInbound(raw: RawWebhook): InboundEvent | null;
  }
  // NormalizedSendParams = { credential, providerPhone, text, recipientE164, leadId? }
  ```
- `registry.ts` — `getAdapter(providerKey)` map. Unknown key throws a typed error caught at preflight (never crashes the drain — guardrail).
- `texthub.ts` — current `lib/sends/texthub.ts` **moved here and wrapped** to implement the interface. Behavior byte-for-byte unchanged; its `toProviderRecipient` is identity/international-format, `parseDlr` returns `null` (TextHub DLR unused). The injected-`Sender` test seam in `drain.ts` is preserved.
- `ahoi.ts` — the new adapter.

**Drain integration:** `drain.ts` resolves `getAdapter(stage.providerKey)` from the stage's provider (one resolution point) and calls `adapter.send(...)` / `adapter.buildRedactedRequest(...)`. No `if/else` sprawl.

---

## 3. Section 1 — Provider adapter skeleton + data model

**Reuse existing tables — zero new provider tables:**
- **`sms_providers`**: one seed row — `sms_provider_id="ahoi"`, `supports_api_send=true`, own circuit-breaker caps + send windows (all existing columns apply).
- **`provider_phones`**: approved Ahoi number(s) registered **manually** via existing UI (no Ahoi numbers-API integration). `toProviderRecipient` strips `+1`→10-digit at send; inbound/DLR matching re-adds `+1`.
- **`provider_credentials`**: one Ahoi row (provider-default, `brand_id=NULL`), `api_key` = Ahoi token (adapter sends it as the `key` param). `inbound_webhook_token` = secret embedded in the Ahoi webhook path. Base URL = adapter constant from `AHOI_API_BASE_URL`.

**Net new schema in Section 1: zero.** Just a seed row + config.

**Section-1 guardrails (carry into build):**
1. Webhook auth = **path token only** (secret in URL path, mirroring TextHub; 207.181.190.0/24 allowlist is defense-in-depth, never the gate).
2. **TextHub suppressed-status path must flow through unchanged** after relocation — explicit regression check on `isSuppressedStatus` → `SendSmsResult.suppressed`.
3. **Unknown provider key = clean per-stage refusal** at preflight (like `no_credential`/`no_short_domain`), never an uncaught throw that kills the drain run.

**Checkpoint:** build Section 1, bring it back for review before Section 2.

---

## 4. Section 2 — Send path + segment policy

**Ahoi `send()`:** POST `/sms/send`, form body `key/source/destination/message`. Classify off the **body** (always-HTTP-200):
- `{status:"ok",uuid}` → `SendSmsResult{ ok:true, messageId:uuid, status:200 }`
- `{status:"error",error}` → `SendSmsResult{ ok:false, error, status:200 }`
- network/timeout → `status:0`

This maps onto the **existing** `classifyAttempt` with no classifier change: `ok+messageId` → `accepted`; `ok:false & status≠0` → `theirs_rejected`; `status:0` → `mine_transport`/`indeterminate`. Ahoi has no per-send suppressed status → `suppressed=false` always.

**Circuit breakers:** unchanged; they read `sms_providers`, so Ahoi's row inherits the failure-spike / rolling-ceiling / latching kill-switch. Send-time rejects feed the reject signal (DLR rejects added in §5).

**Segment policy — single-segment default, per-creative override:**
- **Schema:** new `creatives.allow_multi_segment boolean not null default false`.
- **Counting:** new `lib/sends/segments.ts` — GSM-7 vs UCS-2 detection + segment count (160/70 single, 153/67 concatenated). Exports a hard ceiling constant `MAX_SEGMENTS = 4` (tunable in one place).
- **Enforcement (hard gate at send preflight):**
  - stage rendered text >1 segment AND creative `allow_multi_segment=false` → **per-stage refusal** (`reason:"multi_segment_not_allowed"`), never sent.
  - stage rendered text **> `MAX_SEGMENTS` segments → per-stage refusal (`reason:"segment_ceiling_exceeded"`) even when `allow_multi_segment=true`** (G8 — the override lets you opt into 2–4 segments, never runaway multipart).
  - otherwise (≤1 segment, or ≤`MAX_SEGMENTS` with override on) → allowed, billed per segment.
  - Per-recipient tracked links are fixed-width, so the creative-level count is accurate at kickoff.
- **Advisory at edit:** creative form gets a live encoding + segment-count indicator + warning when text crosses into multi-segment (reuse `SpamCheckStrip` slot pattern). A multi-segment creative can be *saved*; it won't *send* unless the override is on.
- **Cost:** segment count multiplies `cost_per_sms` in estimates.

Provider-agnostic by design (also describes TextHub), but the hard preflight gate is what protects against Ahoi's silent multipart.

---

## 5. Section 3 — DLR + CDR intake (capture + reconcile + two derived signals)

DLR scope = **capture + reconcile only** + two derived aggregate signals. **No `stage_sends` status column written** (per-recipient status deferred, §8).

**DLR webhook:**
- **Endpoint:** `POST /api/webhooks/ahoi/dlr/[token]` — path-token auth → resolves `org+provider`; IP allowlist defense-in-depth. Raw-first, parse-second (mirrors TextHub Stage-A).
- **Capture table:** new append-only `ahoi_dlr_events` — raw_body/query/headers + parsed `uuid, source, destination, send_status, status, smpp_status, smpp_code, error`, plus `matched_stage_send_id`, `processed_at`, `result`.
- **Reconcile:** match `uuid` → `stage_sends.provider_message_id` (the `s-…` uuid stored at send). Multi-segment **numeric-uuid extras won't match → logged as unmatched, not an error.**

**Two derived signals:**
- **(a) reject-rate → circuit breaker:** `send_status=rejected` DLRs contribute to the provider's rolling reject signal in `lib/sends/circuit-breakers.ts`.
- **(b) opt-out-error → suppression layer 3** (see §6). **Defensive mapping:** only a *confirmed* opt-out error signature maps to opt-out; everything else stays "generic reject." **Log any unmapped reject code distinctly** so the real opt-out signature is spottable when it first appears in production. (We have not observed a real opt-out DLR code live — only `000`/`600` — so this mapping is provisional and finalized on first production sighting.)

**CDR poll (reconciliation backstop + opt-out layer 2):**
- **Cron `*/15`** → `/cdrs/download/csv?record_type=sms` over a rolling ET window (today + midnight overlap; CDR timestamps are ET). Filter `direction=in`.
- **Idempotency:** inbound uuid (plain 5-group hex) as key; diff against already-ingested inbound. Inbound seen in CDR but not via webhook → feeds opt-out intake (catches webhook-outage gaps).
- **Known limitation (in-code note):** CDR cannot recover upstream carrier losses (not in it either).

**Table strategy:** provider-specific Ahoi tables (`ahoi_dlr_events`, `ahoi_inbound_events` with `source:'webhook'|'cdr'`) mirroring the proven TextHub shape — **not** generalizing `texthub_inbound_events`.

---

## 6. Section 4 — Opt-out intake (3 layers) + go-live gate

**Intake only *writes* `opt_outs`; existing preflight/eligibility does the suppressing** (no new enforcement code; Ahoi inherits suppression like TextHub).

**Three signal sources → `opt_outs` (org-wide, source-tagged):**
- **Layer 1 — inbound webhook STOP:** `POST /api/webhooks/ahoi/inbound/[token]` → `adapter.parseInbound()` → CamMan keyword match (`lib/sends/opt-out-keywords.ts`) → STOP-class ⇒ `opt_out` (`source:"ahoi_inbound_webhook"`).
- **Layer 2 — CDR poll:** `direction=in` rows → same keyword match ⇒ `opt_out` (`source:"ahoi_cdr"`).
- **Layer 3 — DLR opt-out-error:** defensive-mapped ⇒ `opt_out` (`source:"ahoi_dlr_optout"`).

**Contact matching & the unmatched-number path (decision (a)):** inbound `source` (10-digit) → re-add `+1` → match `contacts.phone_number`. **Mirror TextHub's upsert-contact intake**: on no match, `INSERT INTO contacts (org_id, phone_number) … ON CONFLICT (org_id, phone_number) DO UPDATE …` to materialize the contact, then write `opt_outs` by `contact_id`. Enforcement stays **contact_id-based**, which is provably phone-complete because `contacts` has a unique `(org_id, phone_number)` (number ↔ contact is 1:1). Idempotent on inbound/DLR uuid; `opt_outs` upsert by `(org, phone)`.

**Keyword robustness:** must catch the variants recon surfaced (`STOP`, `STOP please`, `unsubscribe`, …) — verify the existing matcher covers embedded/multi-word STOP.

**Attribution (STOP → which send/stage):** reuse TextHub's `opt_out_attributions` (mig 0075) machinery **if shapes line up cheaply; otherwise fast-follow.** Core suppression does not depend on it.

**Go-live gate (two parts):**
- **Automated suppression-logic harness (HARD BLOCKER):**
  1. Seed a matched test contact → POST synthetic STOP at the real inbound endpoint (valid token) → assert `opt_out` written + suppressed. Repeat for synthetic CDR inbound and synthetic DLR opt-out-error (all 3 layers).
  2. **Unmatched-number path:** POST synthetic STOP from an unknown number → assert contact materialized → `opt_out` → suppressed.
  3. Assert a subsequent send to each suppressed contact is **blocked at preflight**.
  4. **Positive control (guardrail #2):** a non-opted-out contact **still sends** (not blocked).
  - Deterministic, no Ahoi network, re-runs in CI. **`SEND_ENABLED` cannot flip until this passes.**
- **Real-STOP smoke test (proves the wire):** one-time documented procedure — real send → physically text STOP → confirm it travels carrier→Ahoi→**production** endpoint and suppresses. Not automatable; validates portal URL saved + endpoint reachable in prod + real payload decodes like the synthetic one.
- **Go-live** is gated on **both** harness pass **and** smoke-test sign-off — separate from merging code.

---

## 7. Guardrails (consolidated)

- **G1** Webhook auth = path token only; IP allowlist is defense-in-depth.
- **G2** TextHub suppressed-status path unchanged after adapter relocation (regression check).
- **G3** Unknown provider key = clean per-stage refusal, never a drain crash.
- **G4** DLR opt-out mapping is defensive; unmapped reject codes logged distinctly.
- **G5** Separate Ahoi capture tables; do not generalize `texthub_inbound_events`.
- **G6** Number-only opt-outs enforced via upsert-contact intake (contact_id-based, phone-complete by the `(org,phone)` uniqueness).
- **G7** Go-live harness asserts BOTH a suppressed contact is blocked AND a non-opted-out contact still sends; includes the unmatched-number path.
- **G8** Segment ceiling: `MAX_SEGMENTS = 4` constant in `lib/sends/segments.ts`; text over the ceiling is refused at preflight (`segment_ceiling_exceeded`) **even with `allow_multi_segment=true`** — the override enables 2–4 segments, never runaway multipart.

---

## 8. Out of scope / deferred

- **Per-recipient delivery-status tracking** (DLR-driven `stage_sends` status/state machine, UI) — a separate **cross-provider** decision, not Ahoi-only.
- **Ahoi numbers-API** (List/Order Numbers) — manual registration only in Phase 1.
- **MMS** (`/mms/send` exists) — SMS only.
- **`/sms/lookup`** — disabled on this account; not used.
- **Generalizing TextHub's inbound table / suppression SQL** — explicitly avoided.
- Flipping `SEND_ENABLED` — gated, out of the build scope.

---

## 9. Open items

- **O1 (provisional mapping):** exact Ahoi opt-out DLR error code unobserved (only `000`/`600` seen). Layer-3 mapping ships defensive; finalized on first production sighting via the distinct unmapped-code log (G4).
- **O2 (upstream carrier loss):** ~50%-in-test inbound loss is upstream and unrecoverable by webhook or poll; likely a burst-from-single-number artifact. Recommend a realistic multi-number test pre-prod if opt-out completeness is compliance-critical.

---

## 10. Sequencing & checkpoints

1. **Section 1** (adapter skeleton + data model), `SEND_ENABLED` off → **review checkpoint** before Section 2.
2. **Section 2** (send path + segment policy) → checkpoint.
3. **Section 3** (DLR + CDR intake) → checkpoint.
4. **Section 4** (opt-out intake 3 layers + go-live gate) → checkpoint.
5. **Go-live** (separate): harness green + real-STOP smoke test signed off → flip `SEND_ENABLED`.

Each section: hand-authored migration(s) where needed (per project convention — migrations are hand-written, not generated), `verify-migration-integrity` after apply, docs updates (docs/ checklist), tests.

---

## 11. Verification criteria

- **Section 1:** Ahoi provider row + number + credential seed; `getAdapter("ahoi")` resolves; `getAdapter(unknown)` → per-stage refusal (not a throw); TextHub send path unchanged (existing tests green).
- **Section 2:** Ahoi `send()` unit tests over the always-200 body cases → correct `SendSmsResult`/`classifyAttempt` mapping; segment util unit tests (GSM/UCS-2 boundaries + the `MAX_SEGMENTS` ceiling); multi-segment preflight refusal test; **ceiling refusal test (>`MAX_SEGMENTS` rejected even with `allow_multi_segment=true`)**; TextHub send unaffected.
- **Section 3:** DLR endpoint captures + reconciles (matched + unmatched numeric-uuid); reject-rate reaches circuit breaker; CDR poll ingests `direction=in` idempotently; **ET-midnight boundary test — the rolling ET window + midnight overlap ingests inbound straddling 00:00 ET exactly once (no dup, no miss) despite CDR timestamps being ET.**
- **Section 4:** the go-live harness (G7) passes end-to-end; number-only + matched + positive-control all asserted.
- Throughout: `SEND_ENABLED` off; no live sends fired by CI.
