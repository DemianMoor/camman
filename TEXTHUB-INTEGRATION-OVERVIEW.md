# TextHub Integration — Full Architecture

> Reference overview of how CamMan connects to TextHub today, written to support
> enhancing the connection and improving the UI communication around it.
> Source of truth for behavior remains [docs/04-features/sms-send-pipeline.md](docs/04-features/sms-send-pipeline.md)
> and [docs/06-integrations.md](docs/06-integrations.md).

_Generated: 2026-06-16_

## 1. The big picture

TextHub is the **only** real SMS provider CamMan talks to. The integration has two directions:

- **Outbound** — sending one SMS per recipient with a unique tracked link (the "send pipeline").
- **Inbound** — capturing STOP replies to auto-suppress numbers (the "opt-out intake").

Crucially, **live sending has never actually fired in production**. The `SEND_ENABLED` env flag is OFF by default, and everything is gated behind it. The materialize/kickoff side is fully built and exercised; the drain (the part that hits TextHub's send endpoint for real) is owner-gated and untested end-to-end. So as you enhance this, treat outbound as "wired but never switched on."

## 2. The TextHub API contract — the surprising part

TextHub is **not** a normal REST API. Per the original `swagger.json` (which isn't in the repo), **every operation is a `GET` to the same `/` path**, and which operation runs is selected by query flags. Auth is always `api_key` as a query parameter. Base URL: `https://api.texthub.com/v2/`.

Three operations, three files, each with a pure `buildXUrl()` function (so the URL contract is unit-testable without the network) plus a `fetch` wrapper that **never throws** and returns a normalized result:

| Operation | File | Query shape |
|---|---|---|
| **Send SMS** | [lib/sends/texthub.ts](lib/sends/texthub.ts) | `?api_key=&text=&number=&lead_id=` |
| **Poll inbox** | [lib/sends/texthub-inbox.ts](lib/sends/texthub-inbox.ts) | `?api_key=&inbox=true` |
| **Register STOP callback** | [lib/sends/texthub-optout.ts](lib/sends/texthub-optout.ts) | `?api_key=&opt_out_callback=&keywords=` |

**Two iron rules in the send URL** ([lib/sends/texthub.ts](lib/sends/texthub.ts)):

- **Never set `long_url`** — that's TextHub's own link shortener; if you set it, TextHub rewrites/clobbers our tracked link. The tracked URL goes inside `text` and `long_url` stays unset, which is what keeps our link intact.
- **Never set `group`** — a group blast shares one `text` body across recipients, which destroys the per-recipient unique link. Always send a single `number`.

**TextHub's HTTP status codes are unreliable.** The inbox call signals success via the *body* (`body.status === 200`), not the HTTP status — registration even returns HTTP 404 on a failure envelope. So the inbox and registration paths deliberately surface the **raw response** rather than trusting an assumed success shape. The opt-out callback registration contract in particular is flagged `UNVERIFIED` because the swagger spec was never captured.

## 3. Credentials — where the `api_key` lives

The `api_key` is **not** an env var. It's stored per-org, per-provider, optionally per-brand, in the `provider_credentials` table ([db/schema.ts](db/schema.ts)):

- **Plaintext at rest** — a conscious v1 tradeoff. Protected by deny-by-default RLS (no policies exist → only the privileged server connection reads it) plus app-layer `providers.update` permission checks. Encryption-at-rest is deferred.
- **Brand-scoped resolution** ([lib/sends/provider-credential.ts](lib/sends/provider-credential.ts)): a key is stored per `(provider, brand)`; `brand_id = NULL` is a provider-wide default. At send time, `resolveProviderApiKey()` prefers the brand-specific key, then falls back to the default (`ORDER BY (brand_id IS NOT NULL) DESC`). So a brand with its own TextHub account uses its own key; brands without one share the default.
- `maskApiKey()` returns `••••<last4>` — the plaintext **never** leaves the server. The list endpoint masks before serializing.
- `inbound_webhook_token` is a per-credential secret embedded in the registered STOP callback URL (see §6).

**API routes** under [app/api/providers/[providerId]/credentials/](app/api/providers/[providerId]/credentials/):

- `GET /` — list keys (masked), `POST /` — set/rotate a key (upsert per `(provider, brand)`)
- `DELETE /[credentialId]` — remove a key
- `POST /test` — send one real test SMS with a chosen key (gated by `SEND_ENABLED`)
- `POST /[credentialId]/register-callback` — register the STOP callback

## 4. Data model (the four tables that matter)

- **`sms_providers`** — `supports_api_send` flag (must be true to API-send), per-provider ET send windows, and the circuit-breaker columns (`max_sends_per_run/minute/24h`, `send_paused` + reason + timestamp).
- **`provider_credentials`** — the keys (above).
- **`stage_sends`** — **one row per recipient-message**. Its `id` (a UUID) **is** the link idempotency `send_token` and the `lead_id`. Holds the frozen `rendered_text`, `status` (`pending → sending → sent | failed | rejected`), `texthub_message_id`, `attempts`, `last_error`. A partial unique index on `(stage_id, contact_id) WHERE status IN ('pending','sending')` structurally blocks double-materialization while leaving terminal rows free for genuine resends.
- **`texthub_inbound_events`** — append-only capture of every inbound STOP (both webhook and poll), deduped on `(provider_id, provider_message_id)`.

## 5. Outbound send pipeline — two distinct steps

**Step 1: Kickoff / materialize** ([lib/sends/kickoff.ts](lib/sends/kickoff.ts), `kickoffStageSend`) — creates the `stage_sends` rows but **sends nothing**:

- **Manual mode**: freezes the pasted `short_url` into every row's `rendered_text`; no link minting.
- **Tracked mode**: validates tracking IDs + provider `supports_api_send` + resolvable credential + an active `short_domains` row, then **mints one unique link per recipient** (`send_token = stage_sends.id`).
- It's **batched** for performance — bulk link mint + chunked multi-row inserts. This took a 1000-recipient kickoff from ~178s (which blew the 300s cron limit) down to ~2-3s.
- Refuses with explicit reasons (`no_creative`, `already_pending`, `no_recipients`, `no_provider`, `provider_not_api_capable`, `no_credentials`, `no_short_domain`, etc.).

**Step 2: Drain** ([lib/sends/drain.ts](lib/sends/drain.ts), `runStageDrain`) — the part that **actually calls TextHub**. This is the riskiest code in the system, so it's wrapped in gates and breakers.

Four gates, all must pass before anything is claimed:

1. `campaign_stages.send_approved = true` (deliberate per-stage opt-in, default false)
2. `SEND_ENABLED === "true"` env (re-checked **between batches**)
3. Auth: `CRON_SECRET` Bearer (cron) **OR** `campaigns.drain` permission, manager+ (manual) — `decideDrainAuth()` is kept pure and never falls through to allow
4. Provider `send_paused = false` (latching breaker)

The loop claims a batch with `FOR UPDATE SKIP LOCKED`, flips rows to `sending` (durable **before** the HTTP call), calls `sendSms`, then marks `sent` (+`texthub_message_id`, `sent_at`) or `failed` (+`last_error`). **At-most-once**: only `pending` rows are ever claimed, so a row stuck in `sending` (process died mid-send) is *never* auto-retried — it's surfaced as `stuck` for manual review.

**Circuit breakers** ([lib/sends/circuit-breakers.ts](lib/sends/circuit-breakers.ts), migration 0058):

| Breaker | Type | Default | Behavior |
|---|---|---|---|
| `max_sends_per_run` | soft pacing | 1000 (≤2000) | rows per invocation; never pauses |
| `max_sends_per_minute` | soft rolling | 100 | org-wide; self-throttles |
| `max_sends_per_24h` | soft rolling | 10000 | org-wide |
| `send_paused` | **hard latching** | false | manual panic + auto-trip; needs conscious human resume |

Auto-trips: ≥10 consecutive failures (failure spike) and a `processed > cap` structural tripwire. Hard trips latch `send_paused` and fire a best-effort Telegram alert. Rate counts are org-wide (proxy for "this provider" until a second provider exists).

**Scheduling & quiet hours** ([lib/sends/scheduled.ts](lib/sends/scheduled.ts) + the `*/15` cron at [app/api/cron/send-scheduled/route.ts](app/api/cron/send-scheduled/route.ts)): a stage's `scheduled_at` drives a two-phase cron tick — Phase A materializes due stages, Phase B drains any stage with `pending` rows, both sharing one per-provider per-tick budget so a big audience **resumes across ticks** instead of trying to push everything in one 300s invocation. Sends only fire within the provider's ET send window (default 08:00–21:00).

> **Sender-zone limitation:** the window is the sender's fixed ET zone, not each recipient's local time — not fully TCPA-quiet-hours-safe, a conscious v1 simplification.

One important coupling: **`sent_at` is the scheduler's fire-lock.** For tracked stages, the pipeline owns `sent_at`, so marking a tracked stage `'sent'` via the manual status action is blocked (409) — otherwise it silently cancels the scheduled send. (This actually bit production once — the `sent_at` two-writer collision.)

## 6. Inbound STOP intake — polling, not push

The push callback approach is built but **dormant** because TextHub's `opt_out_callback` registration is broken on their side (returns `status:0` for any URL). So the live intake is **polling**:

- **Registration** (`register-callback`) mints a stable per-credential `inbound_webhook_token`, builds `https://<origin>/api/webhooks/texthub/opt-out/<token>`, and asks TextHub to deliver STOPs there. Returns TextHub's raw response for the operator to eyeball. The origin is resolved from the **actual request host** (immune to a mistyped `NEXT_PUBLIC_SITE_URL`).
- **Webhook receiver** ([app/api/webhooks/texthub/opt-out/[token]/route.ts](app/api/webhooks/texthub/opt-out/[token]/route.ts)) — **Stage A, capture only**. The token *is* the auth (maps to one org/provider/credential); unknown token → 401. It records the raw payload to `texthub_inbound_events` but does **not** parse/suppress. This is a dormant fallback.
- **The live path — polling** ([lib/sends/poll-opt-outs.ts](lib/sends/poll-opt-outs.ts), via `?inbox=true`): for every API-capable credential, fetch the inbox, and for each STOP message, in **one transaction**: dedupe-claim the message (`ON CONFLICT (provider_id, provider_message_id) DO NOTHING`), upsert the contact, insert an **org-wide `opt_out`** (`source = 'sms_inbound'`), and mark the event `suppressed`. If suppression throws, the whole claim rolls back so the STOP is retried next poll — a STOP is never silently dropped. Runs on a `*/15` cron plus an on-demand button on the opt-outs page.

## 7. UI surfaces (the part to enhance)

Two main surfaces today:

**Provider credentials section** ([components/providers/provider-credentials-section.tsx](components/providers/provider-credentials-section.tsx)) — on the provider detail page. A masked-key table with four per-row actions:

- **Add / Rotate key** (write-only password input; never shown again)
- **Send test** — sends one real SMS via a chosen key, echoes the exact `sentText` so the operator can confirm the URL arrives un-rewritten (gated by `SEND_ENABLED`)
- **STOP callback** — registers the opt-out callback, shows TextHub's raw response
- **Remove key**

**Stage send panel** ([components/campaigns/stage-send-panel.tsx](components/campaigns/stage-send-panel.tsx)) — the operating surface for the actual send. Shows gate badges (`SEND_ENABLED`, approval), schedule state, live counts (total/pending/sending/sent/failed), the **real frozen message** with SMS segment count, and the Approve → Kick off → Send-now → Retry-failed actions with an irreversible-send confirmation. `drainBlockedReason` computes a single human-readable reason the Send button is disabled.

These are the obvious places where communication is currently thin:

- TextHub errors mostly surface as toasts and raw response blobs.
- The drain result is a one-line toast.
- Breaker/pause state isn't shown in the stage panel.
- There's no per-recipient delivery view beyond the count tiles (the Activity tab reads `stage_sends` live).

## 8. Current state & known gaps

- **`SEND_ENABLED` is OFF** — outbound has effectively never fired. The drain, scheduling, and breakers are all coded but the live-fire is owner-gated.
- **No DLR** — `texthub_message_id` is stored for *possible* future delivery-receipt polling, but nothing polls it. MMS and two-way conversations are out of scope.
- **Rate ceilings are org-wide**, not per-provider, until a second provider exists.
- **`api_key` is plaintext at rest**; encryption/secret-manager deferred.
- **The opt-out callback contract is unverified** (swagger absent) — only the inbox-poll path is trusted.
- The exposed `api_key` shared in plaintext during setup should be rotated.

## File map (quick reference)

| Concern | Path |
|---|---|
| Send client | [lib/sends/texthub.ts](lib/sends/texthub.ts) |
| Inbox poll client | [lib/sends/texthub-inbox.ts](lib/sends/texthub-inbox.ts) |
| STOP callback register client | [lib/sends/texthub-optout.ts](lib/sends/texthub-optout.ts) |
| Credential resolution | [lib/sends/provider-credential.ts](lib/sends/provider-credential.ts) |
| Kickoff / materialize | [lib/sends/kickoff.ts](lib/sends/kickoff.ts) |
| Drain (real send) | [lib/sends/drain.ts](lib/sends/drain.ts) |
| Circuit breakers | [lib/sends/circuit-breakers.ts](lib/sends/circuit-breakers.ts) |
| Scheduling / quiet hours | [lib/sends/scheduled.ts](lib/sends/scheduled.ts) |
| Opt-out poll logic | [lib/sends/poll-opt-outs.ts](lib/sends/poll-opt-outs.ts) |
| Credentials API | [app/api/providers/[providerId]/credentials/](app/api/providers/[providerId]/credentials/) |
| Inbound webhook | [app/api/webhooks/texthub/opt-out/[token]/route.ts](app/api/webhooks/texthub/opt-out/[token]/route.ts) |
| Scheduled-send cron | [app/api/cron/send-scheduled/route.ts](app/api/cron/send-scheduled/route.ts) |
| Credentials UI | [components/providers/provider-credentials-section.tsx](components/providers/provider-credentials-section.tsx) |
| Stage send panel UI | [components/campaigns/stage-send-panel.tsx](components/campaigns/stage-send-panel.tsx) |
| Schema | [db/schema.ts](db/schema.ts) |
| Canonical feature doc | [docs/04-features/sms-send-pipeline.md](docs/04-features/sms-send-pipeline.md) |
| Integrations doc | [docs/06-integrations.md](docs/06-integrations.md) |
</content>
</invoke>
