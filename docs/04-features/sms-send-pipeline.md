# Feature — SMS Send Pipeline (TextHub)

_Last updated: 2026-06-16_

## 1. Purpose
For **tracked** campaigns, send SMS directly via the TextHub API instead of exporting a CSV. The pipeline **materializes** one row per recipient (minting a unique tracked link each), then a heavily-gated **drain** actually fires the messages. Multiple safety gates and circuit breakers exist because sending is irreversible and costs money.

> **Status:** Kickoff/materialize is built. The real-send drain is owner-gated and has effectively **never fired in production** — `SEND_ENABLED` is OFF. Treat live sending as not-yet-launched.

## 2. Key concepts / entities
- `stage_sends` — one row per recipient-message. Its `id uuid` **is** the link idempotency `send_token`. `rendered_text` frozen at materialization. Status `pending → sending → sent | failed | rejected`.
- `provider_credentials` — brand-scoped TextHub `api_key` (plaintext; see [security-notes.md](../security-notes.md)).
- `sms_providers` circuit-breaker columns + `send_circuit_events` audit log.
- Code: [`lib/sends/`](../../lib/sends/) (`kickoff.ts`, `drain.ts`, `texthub.ts`, `circuit-breakers.ts`, `provider-credential.ts`, `scheduled.ts`, `stage-sms.ts`), [`lib/alerts/`](../../lib/alerts/), [`lib/quiet-hours.ts`](../../lib/quiet-hours.ts).

## 3. How it works

### Operator entry point — "Approve Send" (Workstream 2)
The stage panel collapses the old approve → kickoff → drain buttons into a single **Approve Send** action:
1. The operator sets `scheduled_at` on the stage (or leaves it blank for immediate).
2. **Pre-flight** runs first (`preflightStageSend`, [lib/sends/preflight.ts](../../lib/sends/preflight.ts)) — read-only, returns the recipient count (the "submit N") and the structural blockers (the kickoff refusals; **spam is NOT checked** — it's advisory). Blockers are shown in the dialog; nothing is materialized.
3. On confirm, `POST …/send/approve-send` approves + materializes (kickoff) **atomically** (a refusal rolls back the approval), then:
   - **future schedule** → leave `sent_at` NULL = **armed**; the cron drains it when its window opens (requires `campaigns.activate`),
   - **no/now schedule** → drain **inline** in the same request via `runStageDrainAndRecord` and return the real result (requires `campaigns.drain`, manager+).
- **Abort** (`POST …/send/abort`) recalls an **armed** stage: only while un-released (`sent_at` NULL, nothing sent/sending) it marks the pending rows `rejected`, un-approves, and clears `schedule_missed_at` — re-unlocking the Scheduled field. A stage that already started sending can't be recalled (pause the provider instead).
- The Scheduled field locks while armed (the stage form's `armed` prop) so the time can't change under a materialized batch; aborting unlocks it.

The underlying primitives (Step 1 kickoff, Step 2 drain) are unchanged and still power the cron.

### Step 1 — Kickoff / materialize (`kickoff.ts`, `kickoffStageSend`)
- Creates `stage_sends` rows, one per pool recipient.
- **Manual mode:** freezes the pasted `short_url` into each `rendered_text`; no link minting.
- **Tracked mode:** validates tracking IDs + provider (`supports_api_send`) + credentials + an active `short_domains` row, then mints one unique link per recipient (`send_token = stage_sends.id`). See [tracking-attribution.md](tracking-attribution.md).
- **Destination = the stage's stored `full_url`** (Bug 3 fix). The mint uses the exact Full URL the operator sees/controls in the UI — NOT a server-side rebuild. The old rebuild (`loadStageUrlContext` + `buildStageFullUrl`) diverged from `full_url`: it used the offer `postfix` (set to a page slug like `knd`) and treated a selected UTM tag as `tag_id=value_source`, producing `?knd=<id>&subid3=sub_id3` instead of `?sub_id3=<id>`. `full_url` is used when it carries the stage tracking id; an auto-mode (bare) `full_url` falls back to the rebuild, which now emits the tracking id under the fixed `sub_id3` key (`STAGE_TRACKING_PARAM` in [lib/stage-url.ts](../../lib/stage-url.ts)) — never the per-offer postfix.
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

**Gates + breakers, all must pass:**
1. `campaign_stages.send_approved = true` (deliberate per-stage opt-in; default false).
2. **Two-switch send gate (Workstream 1, migration 0063):** the drain requires BOTH
   - `SEND_ENABLED === "true"` env — the deploy-level **backstop**, left permanently on in Vercel (re-checked **between batches** but env-immutable per invocation); refuses with `send_disabled`, and
   - `org_settings.sends_enabled = true` — the DB-backed **daily on/off** operators flip from Settings → Sending without a redeploy (re-checked between batches via a fresh DB read, giving a true mid-run kill); refuses with `send_disabled_org`.
   These are distinct from the per-provider `send_paused` breaker (#4): the env var is the basement breaker, the DB flag is the operational switch, `send_paused` is "something broke, pause this provider." See [`lib/sends/org-send-flag.ts`](../../lib/sends/org-send-flag.ts) (`getOrgSendsEnabled`) and the audit trail in `org_setting_events`.
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

### Submission integrity, evidence & classification (Workstream 3, migration 0064)
The responsibility boundary: everything up to and including TextHub's response envelope is ours to prove clean; everything after is theirs. UI copy says **"Submitted" / "Accepted by TextHub", never "Delivered"** — there is no DLR.

- **Reconciliation (no silent drops)** — `computeStageReconciliation` ([lib/sends/reconcile.ts](../../lib/sends/reconcile.ts)) partitions the frozen pool: `pool = attempted + excluded(opt_out | filter | split) + gap`. `gap = qualified − attempted`; **gap > 0 ⇒ a materialization bug**, surfaced loudly on the stage panel ("Pool 500 = 488 attempted + 12 excluded (12 opt-out). Closed ✓"). The qualification predicate mirrors `stageRecipientsSql` so the two can't diverge.
- **Append-only attempt evidence** — `send_attempts` (one row per attempt) captures the **verbatim** response body, HTTP status, normalized `{ok,messageId,error}`, the **redacted** request (api_key never stored), and the classification. Written by the drain right after each HTTP call. `stage_sends.last_error` is overwritten on retry; this table preserves every attempt.
- **Failure classification** — `classifyAttempt` ([lib/sends/classify-attempt.ts](../../lib/sends/classify-attempt.ts)) buckets each attempt: `accepted` (2xx **with** a message id), `mine_transport` (status 0 connection failure — ours), `theirs_rejected` (any HTTP rejection envelope — escalate), `indeterminate` (timeout after send, 2xx **without** id, unparseable — reconcile). **Two structural rules:** anything not confidently a success ⇒ `indeterminate`, **never** counted as sent; and `indeterminate`/`sending` rows are **never auto-retried** (at-most-once preserved). `summarizeStageAttempts` ([lib/sends/attempt-summary.ts](../../lib/sends/attempt-summary.ts)) rolls the latest attempt per recipient into the panel's failure banner (mine/theirs/indeterminate) + grouped errors.
- **Escalation export** — `GET …/send/escalation` streams a CSV of every `theirs_rejected` / `indeterminate` row (number, `texthub_message_id`, timestamp, classification, HTTP status, redacted request, verbatim response) — the packet handed to TextHub, keyed by their own message id. One-click from the failure banner.
- **Honest limit:** the indeterminate bucket can't be eliminated (a process dying between request and recorded response is genuinely unknown) — it's never hidden, always surfaced as "reconcile with TextHub."

### Scheduling & quiet hours (`scheduled.ts` + `lib/quiet-hours.ts`)
- `scheduled_at` on a stage drives the `*/15` `send-scheduled` cron ([crons.md](crons.md)).
- **Two phases per tick, sharing one per-provider per-tick send budget:**
  - **Phase A — materialize:** for each DUE, *not-yet-materialized* stage (`selectDueScheduledStages`: `sent_at IS NULL` **and** no `stage_sends` rows yet), apply the window decision, then kickoff. Phase A **does NOT stamp `sent_at`** (Bug 1 fix) — the materialized rows themselves prevent re-materialization, and stamping before the drain would mark a stage "Sent" even when the drain is later gate-refused. A permanent refusal (`no_recipients`, `no_credentials`, …) marks `schedule_missed_at` so it stops retrying.
  - **Phase B — resumable drain (decoupled, WS2):** `selectDrainableStages` now drains a stage only when it is **released** (`sent_at` set — first send already happened, so keep draining leftovers) **or DUE for first release** (`scheduled_at <= now`). A stage **pre-materialized for a future schedule** (Approve-Send flow: rows exist, `sent_at` NULL, `scheduled_at` in the future) is **held** until its time — fixing the landmine where Phase B drained any pending stage regardless of `scheduled_at`. The in-window gate is applied per-stage in JS: **first fire** uses the day-anchored `decideScheduledSend` (never rolls to a later day — `hold`/`fire`/`missed`); **continuation** of a released stage drains only while `isOutsideSendWindow(now)` is false, else holds the leftovers for the next window (resumable across days, never out-of-hours, never stranded). Budget is checked **before** the window gate. **`sent_at` is stamped IF AND ONLY IF the drain actually attempted ≥1 send (`processed > 0`)** (Bug 1 fix): a gate-refused drain (env/DB switch off, `send_paused`, etc.) returns `processed 0`, leaves `sent_at` NULL, and the stage stays armed + re-selectable — never a false "Sent". New result counter `drain_held`.
- Per-provider **ET send window** (`send_window_weekday/weekend_start/end`, default 08:00–21:00 ET). `decideScheduledSend(cfg, scheduledAt, now)` returns `hold` / `fire` / `missed`. The window anchors to `scheduled_at`'s ET day — once it closes the send is `missed` (sets `schedule_missed_at`, stays reschedulable), never rolled to the next day.
- ⚠️ **Sender-zone limitation:** the window is evaluated in the sender's fixed ET zone, **not** each recipient's local time. Not fully TCPA-quiet-hours-safe for non-Eastern recipients. Conscious v1 simplification.
- **`sent_at` is the scheduler's fire-lock.** `selectDueScheduledStages` only selects stages with `sent_at IS NULL`; the atomic claim stamps it. A stage with `sent_at` set is treated as already-fired and **permanently skipped** by the cron. Because of this, marking a **tracked** stage `'sent'` via the manual status action is **blocked** (`POST …/status` returns 409 `tracked_stage_sent_is_pipeline_owned`) — for tracked campaigns the pipeline owns `sent_at`; manual bookkeeping must not write it (doing so silently cancels the scheduled send, and reverting the status would not clear `sent_at`). To stop a tracked send, un-approve or reschedule the stage. The stage status dropdown hides `'sent'` for tracked campaigns.

### Alerts (`lib/alerts/`)
Best-effort Telegram alerts on breaker trips / poller failures. If `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are unset, the alerter is a silent no-op and the drain/poller run unaffected.

## 4. Data it reads/writes
- Writes `stage_sends`, `send_attempts`, `links`, `send_circuit_events`, `sms_providers.send_paused*`.
- Reads `provider_credentials`, `org_settings`, `campaign_audience_pool`, `campaign_stages`, `short_domains`.

## 5. UI surface
- `components/campaigns/stage-send-panel.tsx` — the **Approve Send** surface (collapsed approve → materialize → arm/send, with pre-flight + confirm), the **armed** state + **Cancel armed send** (abort), and "Send now" for leftovers. The "Live sending" gate badge + blocked-reason reflect the effective two-switch gate and name the exact blocker. Also shows the **reconciliation** line, a persistent **failure banner** (mine/theirs/indeterminate + grouped errors), and a one-click **escalation packet** export. Count tile + drain toast say "Submitted" / "accepted by TextHub", never "Delivered".
- `app/(protected)/settings/sending/page.tsx` + `components/settings/send-toggle.tsx` — the master "Live SMS sending" switch (manager+; confirm-on-enable; shows env-backstop state + who/when last changed). API: `GET/PUT /api/settings/sending`.
- `components/sends/live-sending-banner.tsx` — the global live-sending master-state indicator (Bug 2). Reads the same source (`GET /api/settings/sending`) and renders the effective two-switch state prominently on the **stage send panel** and the **provider page**, distinct from provider capability/breaker badges, with a link to Settings when it's the org switch that's off. Prevents misreading provider "Active" badges as "sending is live".
- Provider settings expose the send window + circuit-breaker fields and pause/resume.

## 6. Rules & edge cases
- A resend after a terminal batch mints fresh `stage_sends` rows/tokens (no `(stage_id, contact_id)` unique on terminal rows).
- `kickoffStageSend` and `runStageDrain` operate **entirely on `stage_sends`** and never touch `campaign_stages.status`/`sent_at`. `sent_at` is stamped by the callers: the scheduler's phase A (after a successful materialize) and the manual drain backfill (`COALESCE`, when `processed > 0`). `sent_at` is the scheduler's "materialized & handed to the drain" marker + the stage's Scheduled-field lock — see [07-conventions.md](../07-conventions.md). `status` is reconciled separately via the `/status` action (results import / manual), which is **blocked** from setting `'sent'` on a tracked stage.

## 6a. Activity audit
- `send_kickoff` (recipient count) and `send_drain` (sent / failed / stop reason; actor NULL for cron runs) are written to `campaign_events` via `logCampaignEvent()` and surfaced in the campaign **Activity** tab. See [campaign-activity-log.md](campaign-activity-log.md). Per-recipient `stage_sends` rows are read live by the Activity drill-down — not duplicated into the event log.

## 7. Extension points / limitations
- DLR polling, MMS, inbound conversations: out of scope.
- Rate ceilings are org-wide until provider #2; per-provider accounting is a known follow-up.
- `api_key` is plaintext at rest — encryption/secret-manager is deferred.
- See memory notes: live-fire is owner-gated and has not been exercised end-to-end.
