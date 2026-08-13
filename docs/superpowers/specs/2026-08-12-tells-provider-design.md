# Tells.co SMS provider — design (Phases 0–5)

**Status:** **Phase 0 CLOSED (2026-08-12).** Design approved; Phases 1–5 gated.
**Last updated:** 2026-08-12
**Provider key:** `tls`
**Build gate:** txr S1 passing **and** ClickUp card [`869e97atu`](https://app.clickup.com/t/869e97atu) ("Build API Connection with TextRequest") closing. As of 2026-08-12 that card is still `to do`, so Phases 1–5 are blocked.

> **Read §5.1 first.** It is the verified payload contract from the live probe and it **supersedes §2**, which is the pre-probe claim and was wrong in eight places. §2 is kept only to show what changed.

> Sequencing note: an earlier draft of this brief gated Tells on the `feat/textrequest-send` branch merging. That already happened — PR #42 (`102baa2`), with #46/#47 landing after it. The real gate is the two conditions above.

---

## 1. Scope

Add Tells.co as a fourth SMS provider alongside TextHub (`txh`/`txh2`), Ahoi (`ahi`), and Text Request (`txr`), through the existing provider-agnostic adapter registry ([lib/sends/providers/registry.ts](../../../lib/sends/providers/registry.ts)).

Outbound send + delivery receipts + inbound STOP intake. Everything in CLAUDE.md §12 stays out of scope (two-way conversations, MMS sending, per-recipient DLR polling as a product feature, job queues).

**There is no public Tells documentation.** The contract in §2 was assembled from a dashboard screenshot plus direct answers from Tells support, and is the source of truth for this build. Phase 0 replaces every unverified line of it with an observed payload.

---

## 2. API contract as supplied (pre-Phase-0) — ⚠️ SUPERSEDED BY §5.1

**Do not build against this section.** It records what Tells's dashboard screenshot and support answers *claimed* before the live probe. Phase 0 corrected it in eight places, several of which would have caused silent bugs. **[§5.1](#51-payload-contract-verified--this-supersedes-2) is the contract**; this section survives only as the before-picture and to make the corrections legible.

### Send

`GET` or `POST` `https://app.tells.co/api/sms.php`. **We use POST only** — GET puts the API key in the query string, where it lands in access logs and referrers.

| Param | Notes |
|---|---|
| `key` | API key |
| `from` | Sending number (a TFN) |
| `to` | Recipient. Doc examples show bare 11-digit `14242251198`; format confirmed in Phase 0 A1 |
| `message` | Body text |
| `metadata` | Optional passthrough, string or JSON, ~2 KB, **silently truncated** above that. Echoed verbatim on every status webhook for that message |

Success body:
```json
{"id":"3","to":14242251199,"from":14242251198,"message":"Hi","status":"queued",
 "sms_count":1,"sms_charge":0.009,"date":"2024-05-11T01:25:47+00:00","timezone":"UTC"}
```
Error body: `{"status":"error","message":"Invalid api key."}`

**HTTP status codes are undocumented.** Until Phase 0 A3 says otherwise, classify off the body, not the HTTP status (the Ahoi posture, not the Text Request posture).

### Status webhook (DLR)

`POST` JSON to a URL we configure. Fields: `Id`, `From`, `To`, `Status`, `Date`, `Timezone`, `ErrorMessage`, `Metadata` (omitted when no metadata was supplied on the send).

Status enum: `queued`, `sent`, `delivered`, `undelivered` (the last carrying `ErrorMessage`).

### Inbound webhook

`POST` JSON. Fields: `Key`, `To`, `From`, `Body`, `SMSCount`, `SMSCharge`, `Date`, `Timezone`, plus `NumMedia`/`Media` for MMS. We must respond with success JSON.

### Operational constraints

- **No webhook retries.** 12-second timeout, single attempt. A missed event is gone.
- **No replay, no export, no reconciliation API of any kind.** The message log in their UI is view-only.
- **No idempotency key on send.** A timeout-retry is therefore a potential double-send.
- **Tells does not block sends to opted-out numbers.** The attempt goes out and the toll-free network returns `undelivered`. CamMan suppression is the only pre-send gate — zero provider safety net.
- **Tells adds nothing to message text.** No footer injection; opt-out language is already in our creatives, so no per-provider footer allowance is needed in the segment gate.
- **Rate: 30 MPS per number.** The number is a TFN.

### Casing inconsistency

The send response uses lowercase keys (`id`, `status`); the webhooks use PascalCase (`Id`, `Status`). Assume nothing — Phase 0 B1/B6 record actual casing.

---

## 3. Recon: how the existing providers are built

Reference implementations reviewed: Ahoi ([lib/sends/providers/ahoi.ts](../../../lib/sends/providers/ahoi.ts), migration [0109](../../../db/migrations/0109_ahoi_dlr_inbound_events.sql)) and Text Request ([lib/sends/providers/textrequest.ts](../../../lib/sends/providers/textrequest.ts), migrations [0120](../../../db/migrations/0120_textrequest_provider.sql)/[0122](../../../db/migrations/0122_textrequest_dlr_events.sql)/[0124](../../../db/migrations/0124_textrequest_inbound_events.sql)).

### Patterns Tells must follow

- **`SmsProviderAdapter`** = `key` + `send` + `buildRedactedRequest` + `toProviderRecipient` + `parseDlr` + `parseInbound` ([types.ts](../../../lib/sends/providers/types.ts)). The `key` field is a hardcoded union — adding `"tls"` touches `types.ts` and the `ADAPTERS` map. **`tls` must equal the seeded `sms_providers.sms_provider_id` exactly**, or `getAdapter` throws at send time and sends break on deploy.
- **One pure body-builder reused by both the real send and the redacted audit string**, so they cannot drift (`buildSendBody` / `buildMessagesBody`).
- **`AbortController` timeout, read the body once as text, never throw.** Every failure returns a `SendSmsResult`.
- **Webhook auth is an unguessable path token** at `/api/webhooks/<provider>/<kind>/[token]`, resolved via `provider_credentials.inbound_webhook_token` **scoped by `sms_provider_id`** so another provider's token cannot authenticate ([textrequest-webhook-shared.ts](../../../lib/sends/textrequest-webhook-shared.ts)). Ahoi's IP check is explicitly defense-in-depth and never blocks.
- **Event tables** capture verbatim (`method`/`query`/`headers`/`raw_body`) plus parsed columns plus reconcile columns (`matched_*`, `result`, `processed_at`), with org + `received_at` indexes and an RLS select policy.
- **Migration seeds the provider row only.** Credential and phone number are seeded out-of-band by script so no secret or phone number enters the migration chain (the 0120 pattern).

### Findings that changed the brief

**F1 — The status webhook has no `Key` field.** `Key` is listed only under the inbound webhook. The status webhook carries `Id, From, To, Status, Date, Timezone, ErrorMessage, Metadata` and nothing else. So "origin verification is the `Key` field in the payload" holds for inbound only; for DLR there would be no verification at all. **Resolution:** the house path-token is the primary gate on both routes; `Key` is validated as a secondary check on inbound. Phase 0 B2 confirms whether `Key` appears on status callbacks in practice.

**F2 — `Date`/`Timezone` must be stored as text, not parsed at capture.** This bug class has already cost us twice: TextHub's `received_at` was US Mountain while claiming UTC, which zeroed stage opt-out counters by dropping our own STOP replies as "send-after-stop"; Text Request repeated it. Tells's payload carries a `Timezone` field asserting `"UTC"`. That assertion is unverified. Capture both verbatim; convert only after Phase 0 B5 pins the real zone against a known-time send.

**F3 — Tells has no poll backstop, which is the actual justification for persist-first.** Ahoi and Text Request both process inline in the webhook request, and can afford to, because a cron re-reads the same events from the provider (`ahoi-cdr-poll`, `textrequest-poll`). Tells has no such surface. The append-only table is not a log alongside a recoverable source — **it is the only copy and the only retry surface.**

**F4 — `sms_charge` has nowhere to go.** `SendSmsResult` gained `segmentsCount` in migration 0121, so Tells's `sms_count` maps cleanly. There is no cost field on `SendSmsResult` and none on `send_attempts`. Flagged, not solved — for now `sms_charge` survives only inside `raw_body`.

**F5 — `NormalizedSendParams` has no metadata channel.** It carries `apiKey/text/recipientE164/senderNumber/leadId?/statusCallbackUrl?`. Tells correlates DLRs via echoed `metadata`, and its webhook URL is account-level rather than per-send like Text Request's `status_callback`, so `statusCallbackUrl` does not help. Phase 2 adds one additive optional field (`metadata?: string`), same posture as `statusCallbackUrl`: other adapters ignore it, zero blast radius.

---

## 4. Design: bulletproof webhook capture

The goal: **missing an event is effectively impossible, and any capture failure is detected within minutes.**

### 4.1 Processing model — persist, commit, then best-effort, then ack

The handler:

1. Resolve the path token → `(org_id, provider_id, credential_id)`. Failure path in §4.3.
2. Guarded minimal field extraction (§4.4).
3. **Single INSERT, committed alone.** This is the durability guarantee and nothing is allowed to precede it.
4. Best-effort inline processing (DLR reconcile / STOP suppression), in its own transaction, wrapped so a failure can never propagate.
5. `200`.

A cron sweeper then drains `processed_at IS NULL`, retrying anything the inline attempt missed.

This is a superset of "insert then ack, process in cron". Once step 3 commits, the inline attempt in step 4 is free: even if it blows past Tells's 12-second timeout, the event is already ours — we never needed their ack. The happy path suppresses a STOP within seconds; the sweeper is the guaranteed floor. Neither Ahoi nor Text Request has this retry loop; Tells needs it because it has no poll.

**Never ack what was not stored.** If the INSERT itself fails (database unavailable, constraint violation), return `500` and fire a Telegram alert containing the payload — that alert is the event's last copy.

### 4.2 Idempotency, and counting the no-ops

`dedup_key` is computed in TypeScript at capture:

- DLR: `dlr:{Id}:{Status}`
- Inbound: `in:{From}:{To}:{sha256(Body)}:{Date}`

A partial unique index on `(provider_id, dedup_key) WHERE dedup_key IS NOT NULL` makes capture idempotent. Capture uses `ON CONFLICT … DO UPDATE` that bumps **only** `duplicate_count` and `last_duplicate_at` — never `processed_at`, `result`, or any `matched_*` column, so a duplicate can never reset processing state. Semantically it remains a no-op: no new row, no processing change, always `200`.

**An INSERT that can fail is an event that can be lost**, which is why this is `DO UPDATE` rather than a bare unique constraint with error handling.

**The no-op count is diagnostic.** Tells claims it never retries. Every duplicate therefore means either that claim is false or we replayed deliberately. Both are worth knowing and neither is an incident. `duplicate_count` is surfaced in the weekly runbook (§7) and **never alerts.**

### 4.3 Org resolution, and what happens when it fails

**Resolution:** path token → `provider_credentials.inbound_webhook_token`, inner-joined to `sms_providers` on `sms_provider_id = 'tls'`, returning `(id, org_id, provider_id)`. This is `resolveTellsCredential`, mirroring `resolveTextrequestCredential` exactly. Scoping to `tls` matters: `inbound_webhook_token` is a shared column, and a token belonging to another provider must be treated exactly like an unknown token.

**Failure behavior: reject with `401`, and alert with the payload. `org_id` stays `NOT NULL`.**

Resolution can fail three ways: an unknown/garbage token (overwhelmingly a scanner), a credential-rotation window where Tells still holds the old token, or a deleted/dead credential. The latter two are real event loss and are what the alert exists for.

Rejected over nullable-`org_id`-plus-quarantine because:

- **`org_id NOT NULL` is CLAUDE.md §3 and not negotiable.** A row with no org cannot be RLS-scoped, cannot be swept safely, and processing it would mean writing suppression into a *guessed* org. On a compliance path that is worse than losing the event.
- **Nullable + quarantine turns a public unauthenticated endpoint into an open write primitive.** Anyone who learns the URL prefix could insert unbounded rows, and the quarantine sweep would become a queue of attacker-controlled payloads that we then process.
- **The alert is a genuine last copy**, and it is the same rule the design already applies to a failed insert.

**Two copies, not one.** The rejection path writes the full payload to `console.error` (Vercel runtime logs, queryable) *in addition to* Telegram, so a Telegram outage is not total loss.

**Anti-spam discriminator.** The loud alert fires only when the body parses as JSON *and* carries a Tells-shaped field set (`Id`+`Status` for DLR, `From`+`Body` for inbound). Anything else gets a silent `401` and a `console.warn`. A scanner does not send well-formed Tells DLR JSON. If this ever fires in volume, add a DB-backed throttle then — not speculatively.

**Rotation is procedural.** Rotating a Tells credential's `inbound_webhook_token` must update the Tells dashboard configuration *first*, then rotate. Recorded in the runbook (§7). Whether Tells accepts more than one webhook URL — which would allow a true dual-token window — is unknown and worth checking during Phase 0.

### 4.4 What "guarded extraction" means in the handler

The handler extracts roughly eight strings inside a `try/catch` that writes `NULL` on any failure. This is addressing, not processing: `dedup_key` needs it, and the sweeper's index needs it. `raw_body` is always the source of truth, and a `JSON.parse` in a `try/catch` that degrades to `NULL` cannot lose an event.

The considered alternative — a `GENERATED` column over a `jsonb` cast of the body — was rejected because a malformed body would then fail the insert, which is the precise failure mode this design exists to prevent.

### 4.5 Silence monitors — the SOLE detection layer for broken STOP intake

Telegram, breach-only, following the EPC monitor pattern ([app/api/reports/epc-monitors/route.ts](../../../app/api/reports/epc-monitors/route.ts)) — a periodic all-clear message trains people to ignore the channel.

**Priority raised after Phase 0.** These were originally one safety net among several. They are now the only one. With STOP-undelivered self-healing closed as won't-build (§8) and no reconciliation API in existence, **a broken inbound webhook produces no other symptom** — sends keep succeeding, DLRs keep arriving, dashboards look healthy, and STOPs pile up unsuppressed until a carrier complaint surfaces it. Nothing else in the system can notice. Treat these as compliance infrastructure, not observability polish: **Phase 4 does not ship without them, and Phase 5 does not go live without them armed.**

- **Inbound silence.** Zero inbound events across N thousand Tells sends → alert. STOPs arrive at a predictable rate on any real send; silence means the intake is broken, not that everyone loves us. This is the compliance-critical one.
- **DLR coverage.** After a Tells batch, DLR coverage below threshold within 30 minutes of send completion → alert.

**The DLR-coverage monitor must count events per outcome, not per message** (§5.1):

- a **successful** message produces **2** callbacks — `sent` then `delivered`
- a **failed** message produces **1** — `undelivered`, with no preceding `sent`

A monitor that assumes two events per message will read every genuine failure as a coverage gap and fire constantly, which is how it ends up muted. Compute expected events as `2 × delivered + 1 × undelivered`, or simply track *messages with ≥1 terminal event* rather than raw event counts.

Thresholds are proposed here and **calibrated in Phase 5** against observed rates. A monitor tuned on guesses is a monitor that gets muted.

### 4.6 The `Key` redaction carve-out — a hard Phase 3 requirement

The inbound webhook body contains **the full Tells API key** in its `Key` field (§5.1) — not a webhook secret, the live sending credential.

Applied literally, §4.1's "capture `raw_body` verbatim" would write that credential in plaintext into `tells_webhook_events.raw_body`, where it would land in every database backup and any future export. That breaches CLAUDE.md §11 ("never log secrets") outright.

**The rule:** capture stays byte-for-byte verbatim **except** the `Key` field, which is validated against the stored credential and then replaced with a fixed marker (e.g. `"[REDACTED]"`) before the row is persisted. Surgical — one field, everything else untouched, including whitespace and ordering.

This is **not** contingent on the rotation decision in §5. Rotation was declined because the exposure in runtime logs was judged acceptable; a live credential replicated into every DB backup is a different and larger exposure, and this carve-out stands regardless. Phase 3 is not complete without it.

---

## 5. Phase 0 — live probe checklist

No migrations. The A-series runs from a script; the B/C series arrive at the temporary capture route (§5.0) and are read from Vercel runtime logs.

**A-series driver: [scripts/probe-tells-api.ts](../../../scripts/probe-tells-api.ts)** (modelled on [scripts/probe-textrequest-api.ts](../../../scripts/probe-textrequest-api.ts)).

```sh
npx tsx scripts/probe-tells-api.ts --dry-run    # print every request, send nothing
npx tsx scripts/probe-tells-api.ts              # live — ~7 billable messages
npx tsx scripts/probe-tells-api.ts A3 A5        # only the named probes ("A8" selects A8-1+A8-2)
```

**Key and sending number come from the DATABASE, not env.** The Tells key is pasted into the Accounts UI on the Tells provider page (encrypted at rest, write-only) and the TFN is a `provider_phones` row, so the probe resolves exactly what the real send path would. Decryption uses the same dual-read helper the pollers use, and the key is never printed — the banner shows only the account label and last-4.

Env: `DATABASE_URL` and `TELLS_TO` (required — `TO` is the test handset, the one value that can't come from the DB, and must never be a real contact). Optional: `TELLS_TEST_LINK` (A6 skips without it), `TELLS_API_URL`, `TELLS_CREDENTIAL_ID` (required only if the `tls` provider has more than one account — the script refuses to guess rather than spend on the wrong key), and `TELLS_API_KEY` / `TELLS_FROM` as discouraged escape-hatch overrides.

The banner prints the resolved provider, account, sending number and MPS before anything is sent, and warns if `supports_api_send` is true while no `tls` adapter is registered.

⚠️ **It sends real SMS and costs real money.** Run `--dry-run` first and check the target number in the banner. Every call prints its **HTTP status**, response headers, elapsed time and the raw body verbatim; the API key is the one thing redacted from the printed request line, since it isn't part of the contract being established and the output gets pasted around.

### 5.0 Capture bin — a temporary route on our own infrastructure

**Not webhook.site.** The Tells inbound payload carries our Tells API key in its `Key` field, so captured payloads must not leave our infrastructure.

Capture endpoint: **`/api/webhooks/tells/probe-ec80c2e8c87ec5fe2e20425078af6cac`** ([route](../../../app/api/webhooks/tells/probe-ec80c2e8c87ec5fe2e20425078af6cac/route.ts)). Point **both** Tells config fields — Status Webhook URL and Inbound Message URL — at this same URL.

The route does exactly one thing: write method, headers, full URL and raw body to the console, verbatim, and return `200` JSON. No database, no parsing, no processing. **It is not the Phase 3 handler and must never grow into it** — the directory is deleted when the real routes land in Phase 3.

- **Auth** is the unguessable path segment alone. That is all a short-lived probe needs against scanners. It is not a secret from anyone who can read the repo, and it grants nothing but the ability to write a log line.
- **Reading payloads:** Vercel runtime logs, filtered on `[tells-probe]`. Two lines per event sharing an `eventId` — `meta` (method, URL, headers, byte count) and `body` (raw, verbatim). Split deliberately: Vercel truncates long log lines and an MMS inbound payload carries base64 media that would blow the limit, so keeping metadata on its own line means a truncated body can never cost us the headers, timing and URL too.
- **Distinguishing the two channels:** both config fields point at one URL, and the payload shape separates them (`Id`/`Status` = DLR, `Key`/`Body` = inbound). If Tells accepts a query string in those fields, `?src=dlr` / `?src=inbound` makes the logs filterable for free — the full URL is logged either way.
- **Reachability:** `GET` the URL in a browser to confirm the route is live before configuring Tells. Tells itself always POSTs.
- **Ack shape:** the route returns `{"status":"success","ok":true}`. Tells asks for "a success response in JSON" without specifying the shape, and a probe bin whose ack gets rejected would corrupt the very B7/B9 results it exists to measure.
- **Two one-off probe parameters**, both applied *after* the payload is logged so neither can cost us an event. Tells is never configured with either — they are appended by hand for a single request.
  - `?delay=<ms>` (**B9**): holds the response past Tells's 12s webhook timeout. `?delay=20000` for the real test. Capped at 55s, with `maxDuration = 60` on the route.
  - `?status=<code>` (**B7**): forces a non-2xx ack so we can see whether Tells retries a rejected webhook. `?status=500` for the real test. A value that isn't a plausible HTTP status (200–599 integer) is ignored and falls back to `200`, so a typo can never turn a real capture into a rejected one. The `GET` reachability handler ignores both — a liveness check that hangs or `500`s defeats its own purpose.

**The API key will be in our runtime logs.** Logging is deliberately unredacted — verbatim capture is the entire point of Phase 0 — and the inbound payload's `Key` field is the Tells API key.

**Scheduled action: rotate the Tells API key immediately after Phase 0 closes.** Not "if we want to be strict" — it is a dated step in the Phase 0 exit (§7), because the rotation is **free right now and stops being free later**. Nothing validates `Key` until Phase 3 ships F1's secondary check; from that point on, rotating means coordinating the credential swap with Tells's own cutover. Doing it in the gap costs one credential update and nothing else.

Key rotation carries a **different** ordering constraint from the `inbound_webhook_token` rotation in §4.3, and the two should not be conflated — conflating them produces a wrong runbook step:

- Rotating **our path token** (§4.3): update the Tells dashboard webhook URL *first*, then rotate. Otherwise Tells posts to a URL that no longer resolves and those events are lost outright.
- Rotating the **Tells API key**: the webhook URL is untouched, but because F1/§4.3 validate the inbound `Key` against the stored credential, the new key must land in `provider_credentials` at the same moment Tells starts sending it — otherwise the secondary check begins failing on live inbound. During Phase 0 nothing validates `Key` yet, so rotating now is free; after Phase 3 it is not.

### A. Send path — blocking

| # | Probe | Decides |
|---|---|---|
| A1 | POST with `to=+1XXXXXXXXXX`, then again with bare `14242251198`. Record both. | `toTellsRecipient()` output format |
| A2 | Record the exact success body verbatim, including key casing and value types (is `id` `"3"` or `3`?). | Field extraction; whether `id` needs `String()` coercion like Text Request's `message_id` |
| A3 | Send with a deliberately bad `key`. Record **HTTP status** and body. | The biggest unknown. Ahoi-style (always 200, classify off body) vs Text Request-style (real codes). A wrong guess misclassifies every send |
| A4 | Send with a `from` not on the account, and with `from` omitted. | Whether the adapter's no-sender refusal is the only guard needed |
| A5 | Send >160 chars. Record `sms_count`, `sms_charge`, and whether one `id` or several come back. | `segmentsCount` mapping; whether DLR correlation stays 1:1 with a send. Ahoi split multi-segment sends and emitted extra DLRs under different uuids |
| A6 | Send a real CamMan short link (`/r/<code>`). Fetch the received text. | Link passthrough clean — no rewriting/shortening/wrapping. Attribution dies silently if they rewrite |
| A7 | Send `metadata` as a plain string, then as a JSON object. | Whether `metadata` echoes on the send response at all, and the wire encoding for the object form |
| A8 | Send the identical message twice in quick succession. | Confirms no provider-side dedup — the drain must never retry on timeout |

### B. Webhook path — blocking

| # | Probe | Decides |
|---|---|---|
| B1 | Capture a full status-webhook payload. Record exact field names, casing (`Metadata` vs `metadata`), and Content-Type. | The whole `parseTellsDlr` extraction |
| B2 | **Is `Key` present on the status webhook?** | Whether both routes share one validation path, or DLR is path-token-only (see F1) |
| B3 | Count callbacks per message; record the status sequence and whether every intermediate state fires. | The DLR dedup key; the DLR-coverage threshold for the silence monitor |
| B4 | Confirm webhook `Id` === send-response `id`, same type and format. | Whether message-id correlation is a viable fallback, or `metadata` is the only path |
| B5 | Send at a **known wall-clock instant**; compare the webhook's `Date` against it and against the claimed `Timezone`. | Whether `Timezone: "UTC"` is truthful (see F2) |
| B6 | Capture a full inbound payload. Same casing/Content-Type recording. | `parseTellsInbound`; the inbound dedup key fields |
| B7 | `?status=500` on the capture URL forces a non-2xx ack once. Watch for a retry. | Confirms "no retry" empirically. If they *do* retry, the design gains a free safety net |
| B8 | Round-trip `metadata` end-to-end: confirm it returns verbatim on **every** callback for that message, not just the final one. | Whether DLR→`stage_send_id` correlation is reliable. This is the load-bearing assumption of Phase 2 |
| B9 | `?delay=20000` on the capture URL holds the response ~20s, past their 12s timeout, then returns `200`. Distinct from B7's immediate `500`. | Whether a slow ack is treated differently from an error ack — retry, a "failed" mark in their UI, or nothing. Directly bounds how much inline work §4.1 step 4 can afford |

### C. Opt-out / compliance — blocking; the input to the Phase 3 approval gate

| # | Probe | Decides |
|---|---|---|
| C1 | Reply `STOP` from the test phone. Confirm an inbound webhook fires. | Whether Tells surfaces STOP to us at all. If it swallows it, we have no automated STOP intake and Phase 3 changes shape entirely |
| C2 | Record the STOP inbound payload verbatim — is `Body` exactly `"STOP"` or decorated? | Confirms `isOptOutKeyword()` ([lib/sends/opt-out-keywords.ts](../../../lib/sends/opt-out-keywords.ts)) needs no new keywords |
| C3 | Send to that now-opted-out number again. Record the **exact `ErrorMessage` string** and `Status`. | The literal match text for STOP-undelivered self-healing. Must be exact — it drives an automated suppression write |
| C4 | Was `sms_charge` billed on that undelivered attempt? Check the send response and the Tells UI. | Cost accounting; whether the undelivered path is expensive enough to justify tightening pre-send suppression further |
| C5 | Does C3's send response differ from a normal send (any `status` other than `queued`)? | Whether opt-out is detectable at send time (a `suppressed` bucket, like Text Request's 30050) or only via DLR |

### D. Rate / limits — non-blocking, informs Phase 5

| # | Probe | Decides |
|---|---|---|
| D1 | Burst ~40 sends in one second. Record what a breach looks like (429? error body? silent drop?). | Whether the drain needs Tells-specific backoff, and whether breaches are observable at all |
| D2 | Note observed per-send latency. | Drain throughput sizing |

**Exit criteria — ALL MET, Phase 0 CLOSED 2026-08-12.**

1. ✅ Payload contract documented — §5.1 below. Every line is an observed byte, not a claim.
2. ⛔️ **API key rotation — considered and DECLINED** (Dmytro, 2026-08-12). The inbound webhook echoes the full API key (§5.1), so it now sits in Vercel runtime logs and in the exported log files. Rotation was recommended and declined as an accepted risk: the exposure is confined to accounts we control, and the echo is Tells's design rather than a leak we introduced. **This does not relax the Phase 3 redaction requirement (§4.6)** — a credential in a database column is a different exposure class from one in a log with a retention window.
3. 🔁 **Capture-route deletion MOVED to the Phase 3 exit.** It stays live through the Phase 3 build so the real handler can be developed against live traffic. It is a public endpoint; deleting it is a Phase 3 completion criterion, not an optional cleanup.

---

## 5.1 Payload contract (VERIFIED — this supersedes §2)

Captured 2026-08-12 against provider 855 / credential 712 / TFN `+18445694179`. §2 records what was *claimed*; this section records what was *observed*. **Where they disagree, this section wins.**

### Send request

`POST https://app.tells.co/api/sms.php`, `application/x-www-form-urlencoded`, params `key`, `from`, `to`, `message`, optional `metadata`. **Both `+1XXXXXXXXXX` and bare `1XXXXXXXXXX` are accepted for `to`**; the response always echoes the bare 11-digit form, so `toTellsRecipient()` emits bare 11-digit.

### Send response — success (HTTP 200)

```json
{"id":"2303145641","to":"15717709669","from":"18445694179","message":"CamMan probe A1a e164","status":"queued","sms_count":1,"sms_charge":0.0128,"date":"2026-08-12T21:59:02+00:00","timezone":"UTC"}
```

Lowercase keys. `id`/`to`/`from`/`message`/`status`/`date`/`timezone` are **strings**; `sms_count`/`sms_charge` are **numbers**. `metadata` is **not** echoed here. `status` is always `queued` on success.

### Send response — errors (⚠️ ALL HTTP 200)

```json
{"status":"error","message":"Invalid api key."}
{"status":"error","message":"From number is required."}
{"status":"error","message":"Service Unavailable: The phone number (12025550143) is not enabled for SMS API."}
```

**A bad API key returns HTTP 200.** Classification MUST key off the body; HTTP status alone would read a total auth failure as success. Ahoi-shaped, not Text Request-shaped. `from` is validated *before* `key`.

### Send response — duplicate (HTTP 429)

```json
{"status":"error","message":"Duplicate request detected. Please try again later."}
```

A byte-identical repeat is rejected. The brief's "no idempotency key" is wrong — Tells has duplicate detection. Window and key-fields remain unknown, but **Q5 is closed as unreachable**: CamMan excludes a contact from a stage it has already been sent, so this response should never occur in normal operation. Phase 2 therefore treats it as a signal that *our* dedup broke — non-retryable, distinctly marked, and logged at `console.error` (§9 Q5).

### Multi-segment

187 chars → `sms_count: 2`, `sms_charge: 0.0256`, and **one `id`**. Multi-segment does **not** fragment DLRs — 1:1 correlation holds, unlike Ahoi. `sms_charge` is $0.0128 per segment.

### DLR webhook — success path (2 events: `sent`, then `delivered`)

```json
{"Id":2303145809,"To":15717709669,"From":18445694179,"Status":"delivered","Date":"2026-08-12T21:59:09Z","Timezone":"UTC","ErrorMessage":"No error.","metadata":null}
```

### DLR webhook — failure path (1 event: `undelivered`, no preceding `sent`)

```json
{"Id":2303223141,"To":15717709669,"From":18445694179,"Status":"undelivered","Date":"2026-08-12T22:21:58Z","Timezone":"UTC","ErrorMessage":"Network Error","metadata":null}
```

### DLR webhook — with metadata

```json
"metadata":"{\"stage_send_id\":\"00000000-0000-0000-0000-000000000000\",\"probe\":\"a7b\"}"
```

### Inbound webhook (STOP)

```json
{"Key":"<THE FULL TELLS API KEY, 50 chars>","To":18445694179,"From":15717709669,"Body":"Stop","SMSCount":1,"SMSCharge":"0.0128","Date":"2026-08-12T22:19:46+00:00","Timezone":"UTC"}
```

No `Id` field — inbound has no provider message id, which is why the dedup key must be composite. `Body` arrives as `"Stop"` (capitalized, undecorated); `isOptOutKeyword()` uppercases the first token, so it matches unchanged. **Inbound messages are billed** at $0.0128.

### Corrections to §2 — each of these would have caused a silent bug

| §2 claimed | Observed |
|---|---|
| `Metadata` (PascalCase) | **`metadata` — lowercase**, the only lowercase field on an otherwise PascalCase DLR. Reading `Metadata` yields `undefined` on every callback, which would have looked like "Tells doesn't echo metadata" |
| omitted when no metadata supplied | **always present**, `null` when absent |
| metadata is "string or JSON object" | **always returned as a STRING.** A JSON object round-trips as an escaped JSON string; Phase 2 must `JSON.parse` it inside a try/catch |
| `Key` present on the status webhook | **absent entirely.** The path token is the only auth available for DLRs (F1) |
| `Key` = origin verification | **`Key` IS the full API key**, not a separate webhook secret. See §4.6 |
| "No webhook retries. Single attempt." | **4 attempts at exactly 60s intervals (~3 min), then abandoned** — *and the message's remaining statuses are abandoned with it* |
| "No idempotency key on send" | HTTP 429 duplicate detection on byte-identical requests |
| status enum incl. `queued` | The webhook emits only `sent`, `delivered`, `undelivered`. `queued` appears on the send response only |

### Type asymmetries — coerce on both sides

| field | send response | webhook |
|---|---|---|
| `id` / `Id` | string `"2303145641"` | **number** `2303145641` |
| `to` / `To`, `from` / `From` | string | **number** |
| `sms_charge` / `SMSCharge` | **number** `0.0128` | **string** `"0.0128"` (inbound) |

Every shared field crosses the boundary with a different type. Correlation that doesn't coerce will silently never match. Values stay well under 2^53, so no precision risk.

### Dates — all truthfully UTC, two formats, and one trap

Send response and inbound use `+00:00`; the DLR uses `Z`. A parser must accept both. **`Timezone: "UTC"` is truthful** — every `Date` was verified against its receipt time to the second. No TextHub-style lie, so the TEXT-not-timestamptz storage decision (F2) is a cheap safety net rather than a load-bearing fix.

⚠️ **`Date` is the delivery-ATTEMPT timestamp, not the status-transition time.** It advances on every retry (`22:08:54Z` → `22:09:54Z` → …). Never put `Date` in a DLR dedup key — retries would each book a separate event. `(Id, Status)` is correct and was verified stable across 4 redeliveries.

### Operational

- **Source IPs:** DLRs from `3.151.97.159`, `3.151.97.190`, `18.223.179.90`; inbound from `13.59.174.129`. All AWS (ASN 16509) but **different ranges, and inbound uses different infrastructure entirely** — different TLS fingerprint. An IP allowlist is not viable.
- **User-Agent:** DLRs send `TellsWebhookProcessor/2.0 (+18445694179)` — and sometimes `(18445694179)` without the `+`. **Inbound sends no `user-agent` header at all.** Not usable as a signal.
- `content-type: application/json` on both webhooks.
- **Latency:** `sent` ~1s after send, `delivered` ~5s. A failure's `undelivered` lands in <1s. Send API 128–733ms.

---

## 6. Schema — `tells_webhook_events`

Provisionally migration **0129** (`origin/main` is at 0128; renumber if anything lands first). Additive, and it leads the code. Hand-authored, LF line endings, `--> statement-breakpoint` between statements.

```sql
-- Tells.co webhook capture — the persist-first raw event log.
--
-- ONE table with a `kind` discriminator, deliberately unlike the two-table
-- ahoi_*/textrequest_* pattern. Tells has NO retry (12s, single attempt), NO
-- replay, and NO reconciliation API of any kind — so this table is not a log
-- alongside a recoverable source, it IS the only copy and the only retry
-- surface. The handler therefore does one thing: commit a row. Parsing,
-- reconcile and opt-out suppression run afterwards (inline best-effort, then
-- swept by cron over processed_at IS NULL) and are always retryable.
CREATE TABLE public.tells_webhook_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  credential_id         integer REFERENCES public.provider_credentials(id) ON DELETE SET NULL,
  provider_id           integer REFERENCES public.sms_providers(id) ON DELETE SET NULL,
  -- Which route received it. 'dlr' = status webhook, 'inbound' = reply webhook.
  kind                  text NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),

  -- Verbatim capture (house pattern: ahoi_dlr_events, textrequest_dlr_events).
  method                text NOT NULL,
  query                 jsonb,
  headers               jsonb,
  raw_body              text,

  -- Minimal addressing fields, extracted in a guarded try/catch at capture.
  -- This is NOT processing: it is a handful of string reads so the sweeper's
  -- queries and the dedup key are cheap. If extraction throws, every column
  -- here stays NULL and the row still lands — raw_body is the source of truth.
  provider_message_id   text,   -- DLR: Id
  status                text,   -- DLR: Status (queued|sent|delivered|undelivered)
  error_message         text,   -- DLR: ErrorMessage
  from_number           text,   -- payload From, verbatim wire format
  to_number             text,   -- payload To, verbatim wire format
  body                  text,   -- inbound: Body
  metadata_raw          text,   -- DLR: Metadata echoed verbatim (carries stage_send_id)
  -- Date/Timezone stored as TEXT verbatim, NOT timestamptz. Tells claims
  -- Timezone:"UTC"; TextHub made the same claim and sent Mountain, which zeroed
  -- stage opt-out counters, and Text Request repeated the bug. Phase 0 (B5)
  -- pins the real zone; the processor converts. Never cast at capture.
  provider_date         text,
  provider_timezone     text,

  -- Idempotency key, computed in TS at capture:
  --   dlr     -> 'dlr:' || Id || ':' || Status
  --   inbound -> 'in:'  || From || ':' || To || ':' || sha256(Body) || ':' || Date
  -- NULL when extraction failed. Capture upserts against the partial unique
  -- index below, so a replayed event is a no-op, never an error — an INSERT
  -- that can fail is an event that can be lost.
  dedup_key             text,

  -- Duplicate deliveries bump these instead of creating a row. Tells claims it
  -- never retries, so a non-zero count is DIAGNOSTIC: either that claim is
  -- false or we replayed deliberately. Surfaced in the weekly runbook; the
  -- ON CONFLICT DO UPDATE touches ONLY these two columns, never the processing
  -- state below. Never alerts.
  duplicate_count       integer NOT NULL DEFAULT 0,
  last_duplicate_at     timestamptz,

  -- Filled by the processor (inline attempt, or the cron sweeper).
  matched_stage_send_id uuid REFERENCES public.stage_sends(id) ON DELETE SET NULL,
  matched_contact_id    uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  result                text,
  processed_at          timestamptz,
  process_attempts      integer NOT NULL DEFAULT 0,
  process_error         text,

  CONSTRAINT tells_webhook_events_kind_check CHECK (kind IN ('dlr', 'inbound'))
);
--> statement-breakpoint
CREATE INDEX tells_webhook_events_org_id_idx ON public.tells_webhook_events (org_id);
--> statement-breakpoint
CREATE INDEX tells_webhook_events_received_at_idx ON public.tells_webhook_events (received_at);
--> statement-breakpoint
-- The sweeper's work queue. Partial so it stays tiny regardless of table size.
CREATE INDEX tells_webhook_events_unprocessed_idx
  ON public.tells_webhook_events (received_at)
  WHERE processed_at IS NULL;
--> statement-breakpoint
-- Idempotent capture: a replayed webhook (or our own manual replay off this
-- table) collapses to a counter bump. Partial so extraction failures
-- (dedup_key NULL) always land as distinct rows rather than colliding.
CREATE UNIQUE INDEX tells_webhook_events_dedup_uniq
  ON public.tells_webhook_events (provider_id, dedup_key)
  WHERE dedup_key IS NOT NULL;
--> statement-breakpoint
-- DLR coverage / silence monitor + a future delivery-failure breaker
-- (mirrors ahoi_dlr_events_provider_reject_idx).
CREATE INDEX tells_webhook_events_provider_status_idx
  ON public.tells_webhook_events (provider_id, kind, status, received_at);
--> statement-breakpoint
-- Inbound dedup window by contact number (mirrors textrequest_inbound_events_dedup_idx).
CREATE INDEX tells_webhook_events_from_number_idx
  ON public.tells_webhook_events (org_id, from_number, received_at)
  WHERE kind = 'inbound';
--> statement-breakpoint
ALTER TABLE public.tells_webhook_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tells_webhook_events_select_own_org"
  ON public.tells_webhook_events FOR SELECT
  USING (org_id = public.current_org_id());
```

### Capture statement

```sql
INSERT INTO tells_webhook_events (org_id, credential_id, provider_id, kind, method,
                                  query, headers, raw_body, provider_message_id, status,
                                  error_message, from_number, to_number, body,
                                  metadata_raw, provider_date, provider_timezone, dedup_key)
VALUES (…)
ON CONFLICT (provider_id, dedup_key) WHERE dedup_key IS NOT NULL
DO UPDATE SET duplicate_count   = tells_webhook_events.duplicate_count + 1,
              last_duplicate_at = now()
RETURNING id, duplicate_count;
```

`duplicate_count > 0` on the returned row means this delivery was a duplicate. Either way the handler returns `200`.

### Not in this migration, by design

The provider row (`tls`, `supports_api_send = false`) and the `provider_phones` row at `max_sends_per_second = 30` are Phase 1, following the 0120 pattern: provider row seeded by migration, credential and number seeded out-of-band by script so no secret or phone number enters the migration chain.

---

## 7. Phase plan

### Phase 0 — live probe ✅ CLOSED 2026-08-12
§5. Ran against provider 855 / credential 712 / TFN `+18445694179`, ~11 billable messages, ~$0.14. Every A/B/C probe answered (B9 skipped as redundant once B7 mapped the retry behaviour — carried as Q6). Output: **§5.1, the verified payload contract**, which supersedes §2 and corrects it in eight places. Merged against ClickUp card [`869egfjx2`](https://app.clickup.com/t/869egfjx2).

Exit: contract documented ✅ · key rotation **declined** (§5) ⛔️ · capture-route deletion **moved to the Phase 3 exit** 🔁.

### Phase 1 — skeleton
Provider row (`tls`, `supports_api_send = false`), credential via encrypted `provider_credentials`, phone row at `max_sends_per_second = 30`, migration 0129 for `tells_webhook_events`. Additive migration leads the code.

**Already done out-of-band:** the provider row, credential 712 and the TFN phone row were created through the UI during Phase 0 (no migration, no script). `supports_api_send` was set back to `false` on 2026-08-12 after being found `true` with no adapter registered. So Phase 1 reduces to the migration plus the adapter skeleton.
**Gates:** ClickUp card before migration or merge. Migration itself = Dmytro approval.

### Phase 2 — send path
Adapter maps `NormalizedSendParams` → POST, per the verified contract in §5.1: bare 11-digit recipients, **classify off the body not the HTTP status**, coerce `id` to string. Adds the additive optional `metadata` field to `NormalizedSendParams` (F5); `metadata` carries `stage_send_id` for DLR correlation, and comes back as an escaped JSON **string** to be parsed. **No retry on timeout** — a timeout may have landed, so a retry is a potential double-send regardless of Tells's own dedup.

**✅ BUILT 2026-08-13.** `classifyTellsSend(httpStatus, rawBody)` is a pure function (no network) so the whole matrix is unit-testable — [scripts/test-tells-send.ts](../../../scripts/test-tells-send.ts), 41 assertions over the verbatim §5.1 fixtures. `sms_count` maps to `segmentsCount`. The drain threads `metadata: { stage_send_id }` unconditionally (no lookup needed, other adapters ignore it) and mirrors it into the redacted `send_attempts` audit string so the evidence matches the wire.

Two decisions worth recording:
- **`ok: true` is never returned without a `messageId`.** The drain keys its `sent` bucket off `res.ok` alone, so a `queued`-with-no-id response must normalize to a failure — otherwise a row is marked sent with a null message id and correlation is lost.
- **The 429 is NOT a fifth `AttemptClassification` value.** `send_attempts.classification` is CHECK-constrained to four values (migration 0064) and feeds the reports enum in `lib/sends/attempt-summary.ts`; a fifth means a migration plus a report ripple. It gets a distinct `providerStatus = "duplicate"` marker plus a `console.error` instead — which, given Q5's closure, is the more useful signal anyway: it means *our* dedup broke.

### Phase 3 — webhook intake
§4. Both routes, the sweeper cron, the dedup counter, the org-resolution failure path.

**Hard requirements, not optional polish:**
- **`Key` redaction before persist (§4.6).** The inbound body carries the live API key; it must never reach `raw_body`.
- **Delete the temporary capture route** (`app/api/webhooks/tells/probe-*`). Moved here from the Phase 0 exit so the real handler can be built against live traffic. It is a public endpoint — Phase 3 is not complete while it exists.

**No longer gated:** STOP-undelivered self-healing is **closed as won't-build** (§8), so Phase 3 no longer carries a compliance-approval gate.

### Phase 4 — monitors + runbook
**Elevated after Phase 0: these monitors are the only detection layer for broken STOP intake (§4.5). Phase 4 does not ship without them.** Both silence monitors, the insert-failure alert, the org-resolution-failure alert, and the weekly reconciliation runbook:

- Tells UI counts vs CamMan `send_attempts` + inbound counts for the same day. This is the only true reconciliation available.
- `SUM(duplicate_count)` and the count of rows with `duplicate_count > 0` for the period — diagnostic only, never an alert.
- Rows still at `processed_at IS NULL` older than one sweeper interval.
- Credential rotation procedure: update the Tells dashboard webhook URL **first**, then rotate `inbound_webhook_token`.

### Phase 5 — gated go-live
Flip `supports_api_send` only after all three:
1. One small live send (~200–500) with DLR coverage verified against the Tells UI.
2. At least one real STOP captured end-to-end into suppression.
3. Monitors armed, with thresholds calibrated against observed rates rather than guesses.

Then ramp from ~10/s toward 30/s over days. **30 is Tells's limit, not the toll-free network's tolerance for a fresh TFN.**
**Gate:** pacing values = Dmytro approval.

---

## 8. STOP-undelivered self-healing — CLOSED, WON'T BUILD

**Decision: 2026-08-12, on Phase 0 probe C3 evidence. This is closed, not deferred.**

The design was: a DLR with `Status: undelivered` and a STOP-related `ErrorMessage` means the network knows about an opt-out we missed, so auto-write that number to suppression. It was the only automated recovery for a missed STOP, and it was gated on Phase 0 producing the exact error string.

**Probe C3 produced `ErrorMessage: "Network Error"`.** A message sent to a handset that had just opted out came back:

```json
{"Id":2303223141,"Status":"undelivered","ErrorMessage":"Network Error","metadata":null, …}
```

That string is not opt-out-specific. It is exactly what a transient carrier failure, an unreachable handset, a dead number, or congestion would also produce. **No field in the payload distinguishes "recipient opted out" from "delivery failed for a boring reason"** — not `Status`, not `ErrorMessage`, not anything else.

**Why that closes it rather than deferring it.** Keying auto-suppression off `"Network Error"` would permanently remove reachable, consenting contacts from the audience every time a delivery hiccupped. That failure is:

- **silent** — a suppressed contact looks identical to a legitimately opted-out one
- **compounding** — every transient failure permanently shrinks the addressable audience
- **hard to undo** — nothing records *why* a number was suppressed, so there's no safe way to reverse it later
- **directly revenue-costing**, in exchange for recovering an opt-out we would have captured via the inbound webhook anyway

The feature is not blocked on a threshold, an approval, or a better regex. **The signal it requires does not exist at this provider.** Do not reopen it unless Tells introduces a distinct opt-out error code — and if that happens, verify it against a live probe first, because the doc has been wrong about this API in eight separate places (§5.1).

**Consequence, carried into §4.5:** the inbound webhook is now the *only* automated STOP path, and the inbound-silence monitor is the *only* thing that can notice it breaking. Priority raised accordingly.

---

## 9. Open questions

| # | Question | Resolved by |
|---|---|---|
| Q1 | Where does `sms_charge` live? No field on `SendSmsResult`, no column on `send_attempts` (F4). Today it survives only inside `raw_body`. Phase 0 confirmed it's worth persisting: $0.0128/segment, and **inbound messages bill too**. | Phase 2 design |
| Q2 | Does Tells accept more than one webhook URL per account? If so, path-token rotation gets a true dual-token window instead of a procedural one. | Not answered in Phase 0; opportunistic |
| Q3 | What are the actual silence-monitor thresholds? | Phase 5 calibration |
| Q4 | Does the toll-free network tolerate 30 MPS on a fresh TFN? | Phase 5 ramp |
| ~~Q5~~ | ~~**What does the send-side duplicate detection key on, and over what window?**~~ **CLOSED 2026-08-13 by Dmytro — not by probing Tells, but by ruling it out from our side.** CamMan's system design guarantees a contact never receives the same message twice: a contact already sent a stage is excluded from the campaign/stage audience. So Tells's duplicate refusal **cannot fire in normal operation**, and the unknown window is not a product constraint. Consequence for Phase 2: the 429 stays **non-retryable** and keeps its distinct `providerStatus = "duplicate"` marker, **and is logged at `console.error`** — if one ever appears in production it indicates a **CamMan-side dedup bug**, not expected provider behaviour. A silent classification would have hidden exactly that. | ✅ closed |
| Q6 | Does a **slow ack** (>12s) enter the same 4×60s retry path as an error ack? Probe B9 was skipped once B7 mapped the retry behaviour. | Phase 3, if the inline-processing step ever approaches the timeout |

---

## 10. Standing rules that apply

- Recon → findings → approval → build → verify → commit.
- No migrations or merges without a ClickUp card.
- Self-merge on green verification **except**: migrations, opt-out/compliance logic, carrier pacing (Phase 5 caps and ramp), provider credentials, and production data writes — those wait for Dmytro. (The §8 self-healing gate is retired — that feature is closed as won't-build, not pending.)
- Hand-authored multi-statement migrations need `--> statement-breakpoint`.
- The TextHub DLR workstream stays out of this workstream entirely.
