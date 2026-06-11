# Feature — SMS Send Pipeline (TextHub)

_Last updated: 2026-06-12_

## 1. Purpose
For **tracked** campaigns, send SMS directly via the TextHub API instead of exporting a CSV. The pipeline **materializes** one row per recipient (minting a unique tracked link each), then a heavily-gated **drain** actually fires the messages. Multiple safety gates and circuit breakers exist because sending is irreversible and costs money.

> **Status:** Kickoff/materialize is built. The real-send drain is owner-gated and has effectively **never fired in production** — `SEND_ENABLED` is OFF. Treat live sending as not-yet-launched.

## 2. Key concepts / entities
- `stage_sends` — one row per recipient-message. Its `id uuid` **is** the link idempotency `send_token`. `rendered_text` frozen at materialization. Status `pending → sending → sent | failed | rejected`.
- `provider_credentials` — brand-scoped TextHub `api_key` (plaintext; see [security-notes.md](../security-notes.md)).
- `sms_providers` circuit-breaker columns + `send_circuit_events` audit log.
- Code: [`lib/sends/`](../../lib/sends/) (`kickoff.ts`, `drain.ts`, `texthub.ts`, `circuit-breakers.ts`, `provider-credential.ts`, `scheduled.ts`, `stage-sms.ts`), [`lib/alerts/`](../../lib/alerts/), [`lib/quiet-hours.ts`](../../lib/quiet-hours.ts).

## 3. How it works

### Step 1 — Kickoff / materialize (`kickoff.ts`, `kickoffStageSend`)
- Creates `stage_sends` rows, one per pool recipient.
- **Manual mode:** freezes the pasted `short_url` into each `rendered_text`; no link minting.
- **Tracked mode:** validates tracking IDs + provider (`supports_api_send`) + credentials + an active `short_domains` row, then mints one unique link per recipient (`send_token = stage_sends.id`). See [tracking-attribution.md](tracking-attribution.md).
- **Batched (perf-critical).** Minting + inserts are bulk, NOT per-recipient: the shared destination is upserted once, links are inserted in multi-row chunks (`mintLinksBatch` in [lib/links/mint-link.ts](../../lib/links/mint-link.ts), regenerating only the rare colliding `code`), then `stage_sends` is bulk-inserted. This took a 1000-recipient kickoff from ~178s (sequential, blew the 300s cron limit) to ~2-3s. The per-link `mintLink` is retained for single-message paths.
- Partial UNIQUE `(stage_id, contact_id) WHERE status IN (pending,sending)` structurally blocks double-materialization; terminal rows stay free so a genuine resend mints fresh rows. It is also what makes the cron's concurrent-materialize safe (two ticks → one wins, the other's bulk INSERT raises 23505 and is caught).
- Refuses with explicit reasons: `not_found`, `no_creative`, `already_pending`, `no_recipients`, `stage_not_ready`, `no_provider`, `provider_not_api_capable`, `no_credentials`, `no_short_domain`, `no_destination`.

### Step 2 — Drain (`drain.ts`, `runStageDrain`)
```mermaid
sequenceDiagram
  participant Caller as cron / manual (drain perm)
  participant Drain
  participant DB
  participant TH as TextHub
  Caller->>Drain: runStageDrain(stageId)
  Drain->>Drain: gate: send_approved && SEND_ENABLED && !send_paused
  Drain->>Drain: resolve api_key (brand key → default)
  loop until cap / halt
    Drain->>DB: claim batch FOR UPDATE SKIP LOCKED → status=sending
    Drain->>TH: GET send (api_key,text,number,lead_id)
    TH-->>Drain: {ok, messageId, error, status}
    Drain->>DB: sent (+texthub_message_id,sent_at) | failed (+last_error); attempts++
    Drain->>Drain: failure-spike? rolling ceilings? → halt/latch
  end
```

**Three external gates + breakers, all must pass:**
1. `campaign_stages.send_approved = true` (deliberate per-stage opt-in; default false).
2. `SEND_ENABLED === "true"` env (re-checked **between batches** mid-drain so flipping it off stops an in-progress send).
3. `CRON_SECRET` (cron path) / `campaigns.drain` permission, manager+ (manual path).
4. Provider `send_paused = false` (latching breaker).

### TextHub contract (`texthub.ts`)
- `GET https://api.texthub.com/v2/?api_key=…&text=…&number=…&lead_id=…` (timeout default 15s).
- **Never** set `long_url` (TextHub's own rewriter — would clobber our tracked link) or `group` (share link — destroys per-recipient uniqueness).
- Response normalized to `{ ok, messageId, error, status }`. Stores `messageId` for possible future DLR (not polled).

### Circuit breakers (`circuit-breakers.ts`, migration 0058)
| Breaker | Type | Default (NULL ⇒) | Behavior |
|---------|------|------------------|----------|
| `max_sends_per_run` | SOFT pacing | 1000 (clamped ≤2000) | rows claimed per invocation; never pauses |
| `max_sends_per_minute` | SOFT rolling | 100 | org-wide sent count; self-throttles within a run |
| `max_sends_per_24h` | SOFT rolling | 10000 | org-wide sent count (last 86400s) |
| `send_paused` | HARD latching | false | manual panic + auto-trip; requires a **conscious human resume** |

- Soft stops leave rows `pending` for the next tick. Hard stops latch `send_paused=true` (+ reason/at) and fire a Telegram alert.
- **Auto-trips:** failure spike (≥10 consecutive failures) and a pacing tripwire (processed > expected — structural-bug guard). Counts are org-wide as a proxy for "this provider" until a second provider exists.
- Every pause/resume is appended to `send_circuit_events` (actor NULL = auto-trip; actor set = manual). Resumes are manager+ audited actions.

### Scheduling & quiet hours (`scheduled.ts` + `lib/quiet-hours.ts`)
- `scheduled_at` on a stage drives the `*/15` `send-scheduled` cron ([crons.md](crons.md)).
- **Two phases per tick, sharing one per-provider per-tick send budget:**
  - **Phase A — materialize:** for each DUE, *not-yet-materialized* stage (`selectDueScheduledStages`: `sent_at IS NULL` **and** no `stage_sends` rows yet), apply the window decision, then kickoff. `sent_at` is stamped **only after** kickoff succeeds — so a tick killed mid-materialize leaves `sent_at` NULL and the next tick simply retries instead of the stage being stranded (this replaced the old claim-*before*-kickoff order that, combined with the ~178s mint, permanently stranded a 1000-recipient stage). A permanent refusal (`no_recipients`, `no_credentials`, …) marks `schedule_missed_at` so it stops retrying.
  - **Phase B — resumable drain:** every tracked stage that still has `pending` stage_sends (`selectDrainableStages`, independent of `sent_at`) is drained in a batch bounded by the provider's remaining per-tick budget. This is what makes large audiences safe — sending **resumes across ticks** instead of trying to push the whole audience inside one 300s invocation. Just-materialized stages are drained in the same tick.
- Per-provider **ET send window** (`send_window_weekday/weekend_start/end`, default 08:00–21:00 ET). `decideScheduledSend(cfg, scheduledAt, now)` returns `hold` / `fire` / `missed`. The window anchors to `scheduled_at`'s ET day — once it closes the send is `missed` (sets `schedule_missed_at`, stays reschedulable), never rolled to the next day.
- ⚠️ **Sender-zone limitation:** the window is evaluated in the sender's fixed ET zone, **not** each recipient's local time. Not fully TCPA-quiet-hours-safe for non-Eastern recipients. Conscious v1 simplification.
- **`sent_at` is the scheduler's fire-lock.** `selectDueScheduledStages` only selects stages with `sent_at IS NULL`; the atomic claim stamps it. A stage with `sent_at` set is treated as already-fired and **permanently skipped** by the cron. Because of this, marking a **tracked** stage `'sent'` via the manual status action is **blocked** (`POST …/status` returns 409 `tracked_stage_sent_is_pipeline_owned`) — for tracked campaigns the pipeline owns `sent_at`; manual bookkeeping must not write it (doing so silently cancels the scheduled send, and reverting the status would not clear `sent_at`). To stop a tracked send, un-approve or reschedule the stage. The stage status dropdown hides `'sent'` for tracked campaigns.

### Alerts (`lib/alerts/`)
Best-effort Telegram alerts on breaker trips / poller failures. If `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are unset, the alerter is a silent no-op and the drain/poller run unaffected.

## 4. Data it reads/writes
- Writes `stage_sends`, `links`, `send_circuit_events`, `sms_providers.send_paused*`.
- Reads `provider_credentials`, `campaign_audience_pool`, `campaign_stages`, `short_domains`.

## 5. UI surface
- `components/campaigns/stage-send-panel.tsx` — approve + trigger send.
- Provider settings expose the send window + circuit-breaker fields and pause/resume.

## 6. Rules & edge cases
- A resend after a terminal batch mints fresh `stage_sends` rows/tokens (no `(stage_id, contact_id)` unique on terminal rows).
- `kickoffStageSend` and `runStageDrain` operate **entirely on `stage_sends`** and never touch `campaign_stages.status`/`sent_at`. `sent_at` is stamped by the callers: the scheduler's phase A (after a successful materialize) and the manual drain backfill (`COALESCE`, when `processed > 0`). `sent_at` is the scheduler's "materialized & handed to the drain" marker + the stage's Scheduled-field lock — see [07-conventions.md](../07-conventions.md). `status` is reconciled separately via the `/status` action (results import / manual), which is **blocked** from setting `'sent'` on a tracked stage.

## 7. Extension points / limitations
- DLR polling, MMS, inbound conversations: out of scope.
- Rate ceilings are org-wide until provider #2; per-provider accounting is a known follow-up.
- `api_key` is plaintext at rest — encryption/secret-manager is deferred.
- See memory notes: live-fire is owner-gated and has not been exercised end-to-end.
