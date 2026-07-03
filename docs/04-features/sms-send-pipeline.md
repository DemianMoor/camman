# Feature — SMS Send Pipeline (TextHub)

_Last updated: 2026-07-03_

## 1. Purpose
For **tracked** campaigns, send SMS directly via the TextHub API instead of exporting a CSV. The pipeline **materializes** one row per recipient (minting a unique tracked link each), then a heavily-gated **drain** actually fires the messages. Multiple safety gates and circuit breakers exist because sending is irreversible and costs money.

> **Status:** Kickoff/materialize is built. The real-send drain is owner-gated and has effectively **never fired in production** — `SEND_ENABLED` is OFF. Treat live sending as not-yet-launched.

## 2. Key concepts / entities
- `stage_sends` — one row per recipient-message. Its `id uuid` **is** the link idempotency `send_token`. `rendered_text` frozen at materialization. Status `pending → sending → sent | failed | rejected | filtered` (`filtered` = TextHub-suppressed; migration 0065 — see §"Filtered (TextHub-suppressed)" below).
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
   - **explicit "Send now"** (body `send_now: true`) → stamp `scheduled_at = now()` **before** kickoff (so the no-schedule guard passes), then drain **inline** in the same request via `runStageDrainAndRecord` and return the real result (requires `campaigns.drain`, manager+),
   - **already-due non-null date** → send now (its time has arrived),
   - **null date, not an explicit send-now** → **rejected** (`reason: "no_schedule"`). A null `scheduled_at` is never an implicit "now" — the operator must set a date or use Send now. This is what stops a copied/duplicated stage (which always starts with a blank date — see [conventions](../07-conventions.md)) from firing the moment it's approved.
- **Abort** (`POST …/send/abort`) recalls an **armed** stage: only while un-released (`sent_at` NULL, nothing sent/sending) it marks the pending rows `rejected`, un-approves, and clears `schedule_missed_at` — re-unlocking the Scheduled field. A stage that already started sending can't be recalled (pause the provider instead).
- The Scheduled field locks while armed (the stage form's `armed` prop) so the time can't change under a materialized batch; aborting unlocks it.

The underlying primitives (Step 1 kickoff, Step 2 drain) are unchanged and still power the cron.

### Step 1 — Kickoff / materialize (`kickoff.ts`, `kickoffStageSend`)
- Creates `stage_sends` rows, one per pool recipient.
- **Manual mode:** freezes the pasted `short_url` into each `rendered_text`; no link minting.
- **Tracked mode:** validates tracking IDs + provider (`supports_api_send`) + credentials + an active `short_domains` row, then mints one unique link per recipient (`send_token = stage_sends.id`). See [tracking-attribution.md](tracking-attribution.md).
- **Destination = the stage's stored `full_url`** (Bug 3 fix). The mint uses the exact Full URL the operator sees/controls in the UI — NOT a server-side rebuild. The old rebuild (`loadStageUrlContext` + `buildStageFullUrl`) diverged from `full_url`: it used the offer `postfix` (set to a page slug like `knd`) and treated a selected UTM tag as `tag_id=value_source`, producing `?knd=<id>&subid3=sub_id3` instead of `?sub_id3=<id>`. `full_url` is used when it carries the stage tracking id; an auto-mode (bare) `full_url` falls back to the rebuild, which now emits the tracking id under the fixed `sub_id3` key (`STAGE_TRACKING_PARAM` in [lib/stage-url.ts](../../lib/stage-url.ts)) — never the per-offer postfix.
- **Batched (perf-critical).** Minting + inserts are bulk, NOT per-recipient: the shared destination is upserted once, links are inserted in multi-row chunks (`mintLinksBatch` in [lib/links/mint-link.ts](../../lib/links/mint-link.ts), regenerating only the rare colliding `code`), then `stage_sends` is bulk-inserted. This took a 1000-recipient kickoff from ~178s (sequential, blew the 300s cron limit) to ~2-3s. The per-link `mintLink` is retained for single-message paths. Chunk sizes: `MINT_BATCH_CHUNK = 2000` (11 cols × 2000 = 22K bind params) and `STAGE_SENDS_CHUNK = 1000` (kept lower — `rendered_text` is a wide column); both well under Postgres's 65535-param limit. Each chunk is one round-trip, so the chunk size is the round-trip divisor for a stage's materialization.
- Partial UNIQUE `(stage_id, contact_id) WHERE status IN (pending,sending)` structurally blocks double-materialization; terminal rows stay free so a genuine resend mints fresh rows. The windowed `stage_sends` INSERT is `ON CONFLICT … DO NOTHING` against it, so re-runs + concurrent materializers are idempotent (no 23505 to catch).
- **Windowed + RESUMABLE (WS5).** Materialization is O(recipients) index-maintenance work (measured ~3.5 ms/recipient), so a single atomic kickoff timed out around ~17K recipients and rolled the **whole** batch back. `kickoffStageSend` ([lib/sends/kickoff.ts](../../lib/sends/kickoff.ts)) now takes the base `db` and materializes in **committed 2000-row windows** under a time budget (`DEFAULT_MATERIALIZE_BUDGET_MS` 45s for the manual route; 120s per stage for the cron), enumerating only the **not-yet-materialized** recipients (`excludeMaterializedStageId`). It cannot be wrapped in a caller transaction. The completeness signal is **`campaign_stages.materialized_at`** (migration `0089`), set only when the last window lands.
  - **Nothing sends until complete.** `selectDueScheduledStages` (Phase A) resumes any due stage with `materialized_at IS NULL`; `selectDrainableStages` (Phase B) drains ONLY stages with `materialized_at IS NOT NULL`. A partially-materialized audience is therefore never sent — the cron finishes materialization first, then drains. A killed tick / hit budget just resumes next tick from the committed rows (idempotent).
  - **Visibility.** A stage mid-materialization reads the Indigo **"Materializing"** operational status (not "Prepared") — see [daily-volume-ui.md](daily-volume-ui.md). `already_pending` is retired: a re-Prepare is now an idempotent no-op.
  - Backfill: migration `0089` marks every pre-existing stage that already had `stage_sends` rows as complete (they were atomic before), so the new drain gate doesn't strand in-flight sends.
- Refuses with explicit reasons: `not_found`, `no_creative`, `no_schedule`, `already_pending`, `no_recipients`, `stage_not_ready`, `no_provider`, `provider_not_api_capable`, `no_credentials`, `no_short_domain`, `no_destination`.
- **`no_schedule` is the hard null-date guard.** `kickoffStageSend` refuses any stage with a NULL `scheduled_at` before materializing — the shared chokepoint for every entry point (cron Phase A never selects NULLs anyway; the manual kickoff route; Approve-Send). A null date is **never** treated as "send now"; an explicit Send now stamps `scheduled_at = now()` upstream so it passes. This guards the copied-stage auto-fire bug at the pipeline level, not just the UI.

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
    loop slice of `rate` = max_sends_per_second (default 10)
      par parallel network sends
        Drain->>TH: GET send (api_key,text,number,lead_id)
        TH-->>Drain: {ok, messageId, error, status, providerStatus}
      end
      Drain->>DB: BULK-persist slice: ≤2 UPDATEs (sent / failed-or-filtered) + 1 multi-row send_attempts INSERT; attempts++
      Drain->>Drain: fold results IN ORDER (JS): count + failure-spike? → halt/latch
      Drain->>Drain: PACE — sleep so the slice occupies ≥ slice/rate seconds (never burst > rate/sec)
    end
    Drain->>Drain: rolling ceilings checked between batches → stop
  end
```

**Throughput & per-second pacing.** Within each claimed batch the drain processes **slices of `rate`** — the stage phone's `max_sends_per_second` (`resolveSendsPerSecond`, default 10, clamped ≤1000; injectable via `opts.concurrency`, `1` = effectively serial). Three layers:
1. **Parallel network sends** — the slice's `sendSms` calls fire together (`Promise.all`); the ~400ms per-recipient TextHub round-trip was the original ~2 sends/sec ceiling.
2. **Bulk persistence** — the slice's results are then written in **≤2 `UPDATE … FROM (VALUES …)`** (one for `sent`, one for `failed`/`filtered`) **+ one multi-row `send_attempts` INSERT**, instead of 2 round-trips per recipient. This matters independently: parallel sends *alone* left ~20 serial writes per slice dominating at **~2.5 sends/sec measured live** — bulk writes cut that to ~3 statements per slice (~11.5/sec measured).
3. **Pacing** — after persisting, the drain sleeps so a slice of N occupies ≥ N/`rate` seconds, so sustained throughput **never bursts above `rate`/sec** (the provider's hard limit — TextHub 60/s short code, 3/s toll free). The sleep is only the shortfall (when real latency already filled the window, none), and is skipped when stopping. Proportional to slice size, so a partial tail slice waits a fraction, not a full second.

Every statement is a **single query** (never concurrent on one connection), so the drain is correct whether `dbc` is the pool (cron/drain) or a single-connection tx (the test harness — concurrent `execute()` on a postgres-js transaction connection desyncs its pipeline). Counting and the failure-spike breaker then **fold the results in claimed order (JS only)**, so consecutive-failure semantics are unchanged; a slice's sends have all already fired+persisted by the time the breaker trips (≤ `rate−1` past the threshold). This replaced the original strictly-serial `await`-per-recipient loop, which capped throughput at ~2 sends/sec and made a run hit the 300s function timeout at ~600 sends regardless of `max_sends_per_run` (whose hard ceiling was raised 2000→20000 once a 300s invocation could complete that many).

**Gates + breakers, all must pass:**
1. `campaign_stages.send_approved = true` (deliberate per-stage opt-in; default false).
2. **Two-switch send gate (Workstream 1, migration 0063):** the drain requires BOTH
   - `SEND_ENABLED === "true"` env — the deploy-level **backstop**, left permanently on in Vercel (re-checked **between batches** but env-immutable per invocation); refuses with `send_disabled`, and
   - `org_settings.sends_enabled = true` — the DB-backed **daily on/off** operators flip from Settings → Sending without a redeploy (re-checked between batches via a fresh DB read, giving a true mid-run kill); refuses with `send_disabled_org`.
   These are distinct from the per-provider `send_paused` breaker (#4): the env var is the basement breaker, the DB flag is the operational switch, `send_paused` is "something broke, pause this provider." See [`lib/sends/org-send-flag.ts`](../../lib/sends/org-send-flag.ts) (`getOrgSendsEnabled`) and the audit trail in `org_setting_events`.
   - **Emergency hard-stop (migration 0080):** `org_settings.sends_paused` is a SECOND, dedicated org-wide kill-switch independent of `sends_enabled`. When `true`, the drain refuses to start (`send_paused_org`) and an in-flight drain halts at the next batch boundary (`stopReason = "org_paused"`) — no further message is submitted via the provider API until it's cleared. It's flipped one-click from the **Today's sends** screen ("Hard stop" / "Proceed"), re-read fresh each batch (true mid-run kill, same as `sends_enabled`), and audited in `org_setting_events` (`setting_key = 'sends_paused'`). Endpoint: `POST /api/sends/pause` (manager+); helper `getOrgSendsPaused` in [`lib/sends/org-send-flag.ts`](../../lib/sends/org-send-flag.ts). Resuming ("Proceed") just clears the flag — pending rows drain on the next tick.
3. `CRON_SECRET` (cron path) / `campaigns.drain` permission, manager+ (manual path).
4. Provider `send_paused = false` (latching breaker).

### TextHub contract (`texthub.ts`)
- `GET https://api.texthub.com/v2/?api_key=…&text=…&number=…&lead_id=…` (timeout default 15s).
- **Never** set `long_url` (TextHub's own rewriter — would clobber our tracked link) or `group` (share link — destroys per-recipient uniqueness).
- Response normalized to `{ ok, messageId, error, status, providerStatus, suppressed }`. Stores `messageId` for possible future DLR (not polled). `providerStatus` = TextHub's structured `status` envelope field (verbatim); `suppressed` = `isSuppressedStatus(status)`, true only when that field equals `"suppressed"` (case-insensitive).

### Circuit breakers (`circuit-breakers.ts`, migration 0058; `max_sends_per_second` migration 0073)
| Breaker | Scope | Type | Default (NULL ⇒) | Behavior |
|---------|-------|------|------------------|----------|
| `max_sends_per_second` | **phone** (`provider_phones`) | HARD pacing | 10 (clamped ≤1000) | the number's instantaneous rate limit; drain fires ≤ this many in parallel then waits out the second (TextHub: 60/s short code, 3/s toll free) |
| `max_sends_per_run` | provider | SOFT pacing | 1000 (clamped ≤20000) | rows claimed per invocation; never pauses |
| `max_sends_per_minute` | provider | SOFT rolling | 100 | org-wide sent count; self-throttles within a run |
| `max_sends_per_24h` | provider | SOFT rolling | 10000 | org-wide sent count (last 86400s) |
| `send_paused` | provider | HARD latching | false | manual panic + auto-trip; requires a **conscious human resume** |

- **`max_sends_per_second` is per PHONE NUMBER, not per provider** — the per-second ceiling is a carrier limit that depends on the number type, and one provider can own numbers of different types (e.g. TextHub has a short code at 60/s and a toll-free number at 3/s). The drain resolves it from the stage's `provider_phone_id` (`campaign_stages.provider_phone_id` → `provider_phones.max_sends_per_second`). Set per number in Settings → the provider's phone dialog. A stage with no phone (or a phone with no rate) ⇒ the default.
- **Per-second rate vs the volume caps:** the per-second rate bounds the *burst* (never exceed what the carrier accepts), while the provider-level `max_sends_per_minute` / `_24h` bound *sustained volume*. They compose — a rate of 60/s is 3600/min, so a lower `max_sends_per_minute` will still throttle total throughput.

- Soft stops leave rows `pending` for the next tick. Hard stops latch `send_paused=true` (+ reason/at) and fire a Telegram alert.
- **Auto-trips:** failure spike (≥10 consecutive failures) and a pacing tripwire (processed > expected — structural-bug guard). Counts are org-wide as a proxy for "this provider" until a second provider exists.
- Every pause/resume is appended to `send_circuit_events` (actor NULL = auto-trip; actor set = manual). Resumes are manager+ audited actions.

### Submission integrity, evidence & classification (Workstream 3, migration 0064)
The responsibility boundary: everything up to and including TextHub's response envelope is ours to prove clean; everything after is theirs. UI copy says **"Submitted" / "Accepted by TextHub", never "Delivered"** — there is no DLR.

- **Reconciliation (no silent drops)** — `computeStageReconciliation` ([lib/sends/reconcile.ts](../../lib/sends/reconcile.ts)) partitions the frozen pool: `pool = attempted + excluded(opt_out | filter | split | dedup) + gap` (the `dedup` bucket = Phase-2 content-dedup exclusions — saw-this-creative-elsewhere / in-flight / got-this-offer-before; see [content-dedup.md](content-dedup.md)). `gap = qualified − attempted`; **gap > 0 ⇒ a materialization bug**, surfaced loudly on the stage panel ("Pool 500 = 488 attempted + 12 excluded (12 opt-out). Closed ✓"). The qualification predicate mirrors `stageRecipientsSql` so the two can't diverge.
- **Append-only attempt evidence** — `send_attempts` (one row per attempt) captures the **verbatim** response body, HTTP status, normalized `{ok,messageId,error}`, the **redacted** request (api_key never stored), and the classification. Written by the drain right after each HTTP call. `stage_sends.last_error` is overwritten on retry; this table preserves every attempt.
- **Failure classification** — `classifyAttempt` ([lib/sends/classify-attempt.ts](../../lib/sends/classify-attempt.ts)) buckets each attempt: `accepted` (2xx **with** a message id), `mine_transport` (status 0 connection failure — ours), `theirs_rejected` (any HTTP rejection envelope — escalate), `indeterminate` (timeout after send, 2xx **without** id, unparseable — reconcile). **Two structural rules:** anything not confidently a success ⇒ `indeterminate`, **never** counted as sent; and `indeterminate`/`sending` rows are **never auto-retried** (at-most-once preserved). `summarizeStageAttempts` ([lib/sends/attempt-summary.ts](../../lib/sends/attempt-summary.ts)) rolls the latest attempt per recipient into the panel's failure banner (mine/theirs/indeterminate) + grouped errors.
- **Escalation export** — `GET …/send/escalation` streams a CSV of every `theirs_rejected` / `indeterminate` row (number, `texthub_message_id`, timestamp, classification, HTTP status, redacted request, verbatim response) — the packet handed to TextHub, keyed by their own message id. One-click from the failure banner.
- **Honest limit:** the indeterminate bucket can't be eliminated (a process dying between request and recorded response is genuinely unknown) — it's never hidden, always surfaced as "reconcile with TextHub."

### Filtered (TextHub-suppressed) — migration 0065
TextHub rejects a number it blocks on **its** side with a dedicated structured envelope: `{"response":"Error occured, unsubscribed the phone number","status":"Suppressed"}` (HTTP 404, no message id). The drain reads the structured `status` field (now surfaced on `SendSmsResult` as `providerStatus` + the derived `suppressed` flag) and records these as **`stage_sends.status = 'filtered'`** instead of `'failed'` — a distinct, operator-visible bucket so provider-suppression volume is separable from genuine failures (bad number, transport).

- **Strict gate:** `isSuppressedStatus()` ([lib/sends/texthub.ts](../../lib/sends/texthub.ts)) matches the `status` **token** only (`"suppressed"`, case-insensitive) — never the HTTP code, never a substring of the free-text `response`. A transient/other rejection can't be mis-classified as a suppression.
- **LABEL ONLY — no blocking.** A `filtered` row is **not** added to `opt_outs` and is **not** excluded from future campaigns; the number can be re-attempted next send. This is purely an outcome classification. (Auto opt-out capture / pre-send skipping is a separate, deferred decision — TextHub's definition of "Suppressed" is still under discussion.)
- **Surfaced:** the drain returns a `filtered` count (separate from `failed`); the `send_drain` activity event reports it; the **Activity** tab shows a violet **Filtered** summary tile and a `filtered` status filter + badge in the Messages drill-down (NOT part of the "Needs attention" quick-filter — a suppression isn't a row a human must fix).
- **Classification unchanged:** the `send_attempts` evidence row is still `theirs_rejected` with the verbatim `"status":"Suppressed"` body — `filtered` is the `stage_sends` lifecycle bucket, not a new `send_attempts` classification.
- **Operational status:** because `filtered` leaves the `failed` bucket, a fully-drained stage whose only non-sent rows are suppressions reads **green "Sending / Sent"**, not red "Missed / Failed" — suppressions don't flag a stage as needing attention.
- **Breaker note (unchanged behavior):** a `filtered` outcome still increments the per-run consecutive-failure counter exactly as before (suppressions were previously `'failed'`), so a wall of suppressions can still trip the failure-spike pause. Whether suppression *should* feed that breaker is a separate sending-behavior question, intentionally left unchanged here.
- **Historical rows:** the ~262 pre-0065 suppressions stay `status='failed'` (not backfilled) — out of scope for this visibility change.

### Stage split partitioning — stable hash bucket
A stage can carry `split_index`/`split_total` (A/B split of the campaign audience). The bucket predicate is **`splitBucketMatch`** ([lib/sends/split-bucket.ts](../../lib/sends/split-bucket.ts)): `((hashtextextended(contact_id::text,0) % splitTotal) + splitTotal) % splitTotal = splitIndex-1`. A contact's bucket depends only on its own id — **never on the surrounding set** — which is load-bearing for windowed/resumable materialization.

- **Why (incident).** The old bucket was `row_number() over (order by contact_id) % splitTotal`, computed AFTER the resumable "exclude already-materialized" filter. On a resume the row numbers were reassigned over the shrunken remaining set, so the modulo selected a different subset and **leaked the sibling stage's half** into this one — campaign `8_62_070326_1` materialized 7,500 instead of 5,000 per half (5,000 contacts in both stages; 4,926 double-sent). The hash bucket can't shift under resume.
- **One definition, six call sites.** `splitBucketMatch` is the single source; the send recipient query, the all-phones CSV export, the frozen/draft/batched audience-count previews, the content-dedup `will_send` preview, and `computeStageReconciliation` all use it, so preview/export/reconcile mirror exactly what sends.
- **Tradeoff:** buckets are *approximately* even (hash uniformity), not exactly 50/50 — acceptable for A/B splits. Exactly-balanced splits are out of scope.

### Global 1-hour send-dedup gate (migration 0090)
A HARD gate in the drain: before dispatching a claimed batch, any row whose **phone** already has a `status='sent'` row within `SEND_DEDUP_WINDOW_MS` (1h, [lib/sends/dedup-window.ts](../../lib/sends/dedup-window.ts)) — **org-wide, across every campaign/stage** — is marked **`stage_sends.status = 'skipped_duplicate'`** and never sent. Also dedups a phone appearing more than once within the same batch. Terminal: not sent, not opted-out, not auto-retried.

- **Why.** The safety net against ANY duplicate cause — a split-materialization bug, cross-campaign audience overlap, or a rapid intentional drip to the same people. A number never receives two messages within the window, whatever the upstream mistake.
- **Where.** Send-time (the drain) is the only place the prior message's actual `sent_at` is known and the single chokepoint every send passes; backed by partial index `stage_sends(org_id, phone, sent_at) WHERE status='sent'`.
- **Surfaced.** The drain returns a `skippedDuplicate` count (separate from `sent`/`failed`/`filtered`); a **Telegram** alert fires per stage when > 0; the `send_drain` activity event + audit metadata report it; the **Activity** tab shows an orange **"Skipped (1h)"** summary tile + a `skipped_duplicate` status filter/badge. A stage fully drained with nothing sent but rows skipped reads **"Needs attention"**, not green.
- **Behavior note:** an intentional back-to-back drip (stage 1 at 11:00, stage 2 at 11:30 to the same people) will skip the overlap in stage 2 — the strict global rule. Change the window in one place (`SEND_DEDUP_WINDOW_MS`).

### Scheduling & quiet hours (`scheduled.ts` + `lib/quiet-hours.ts`)
- `scheduled_at` on a stage drives the `*/5` `send-scheduled` cron ([crons.md](crons.md)).
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
