# CamMan — SMS Send Pipeline Improvements (Build Brief for Claude Code)

> **Author's intent:** Make daily campaign sending fast, single-commit, and auditable. The operator should be able to run many campaigns a day from a UI, commit a send in one click, and afterward see exactly what happened — with every failure classified as *ours to fix* or *TextHub's to explain*.
>
> **Read first:** `docs/04-features/sms-send-pipeline.md`, `docs/06-integrations.md`, and `TEXTHUB-INTEGRATION-OVERVIEW.md`. Those remain the source of truth for current behavior. This brief defines the *changes*.
>
> _Brief date: 2026-06-16_

---

## 0. Decisions locked (do not re-litigate)

- **Send now = inline drain.** The "Send now" path drains synchronously inside the request and returns a real result. It does **not** hand off to the cron. (Scheduled sends still go through the cron.)
- **Spam score is advisory only.** It is **not** a send gate. If a creative's text was selected for the stage, it is considered approved. Show the score if useful, never block on it.
- **`SEND_ENABLED` env stays `true` permanently in Vercel** as a deploy-level backstop. Day-to-day on/off moves to a DB-backed flag in the UI (Workstream 1).
- **The UI says "Submitted", never "Delivered."** There is no DLR. The strongest claim the system makes is "TextHub accepted it." Do not imply handset delivery anywhere.
- **Responsibility boundary:** everything up to and including TextHub's response envelope is ours to get right and prove. Everything after is TextHub's. The build must make our side provably clean and produce escalation evidence for anything that's theirs.

---

## 0a. Pre-build verification (do these before writing code)

1. **Inspect `lib/sends/drain.ts`** and confirm whether the **raw TextHub response body** is persisted today, or only the normalized `last_error` string. This determines whether Workstream 3 is pure surfacing or also needs the new `send_attempts` table. (Expectation: only normalized fields are stored → the table is needed.)
2. **Inspect `lib/sends/scheduled.ts` → `selectDrainableStages`** and confirm the current Phase B selection predicate. Today it selects tracked stages that have `pending` rows **regardless of `scheduled_at`**. This is the landmine in Workstream 2 — verify it before changing it.
3. **Confirm the current latest Drizzle migration number** (breakers were `0058`, Keitaro `0061–0062`). New migrations in this brief start at the next free number.
4. **Confirm `provider_credentials` redaction helper** (`maskApiKey`) so the attempt log and escalation export never persist or emit a key.

---

## Workstream 1 — UI-controlled send toggle

**Goal:** Stop redeploying to flip live sending. Leave the env flag on; add a DB flag operators control from Settings.

### Build
- **New DB flag:** a `sends_enabled boolean` on an org-settings singleton (extend the existing org/settings table; create one if none exists). Default `false`.
- **Drain gate becomes a conjunction:**
  `env SEND_ENABLED === "true"` **AND** `db sends_enabled === true` **AND** `stage.send_approved` **AND** provider `!send_paused`.
  Keep the env check exactly as-is (still re-checked between batches). Add the DB check alongside it.
- **Settings UI:** a clearly-labeled master switch — "Live SMS sending: ON/OFF" — with current state, who last changed it, and when.
- **Permission-gate** the toggle to owner/manager only.
- **Audit every flip.** Reuse the `send_circuit_events` pattern (or a settings-audit row): actor, timestamp, old→new value.

### Why two switches
`send_paused` already exists but is a *per-provider breaker* ("something broke, pause"). This new flag is a *global operational on/off*. The env var is the basement breaker — untouched in daily use, there only if a UI bug or compromised session flips the DB flag. Don't collapse them into one.

### Acceptance
- Flipping the Settings switch enables/disables live sending with no redeploy.
- Drain refuses cleanly when either env or DB flag is off, with a distinct reason for each.
- Every toggle is attributable in the audit log.

---

## Workstream 2 — Collapse to a single "Approve Send" commit

**Goal:** Replace *approve → kickoff → send* with one operator action: set a schedule, click **Approve Send**, confirm, done. Materialization happens automatically at commit; drain happens inline (send-now) or at the scheduled time (cron).

### New stage UX
1. Operator sets `scheduled_at` on the stage (or leaves it blank for immediate).
2. If the stage is an **API/tracked** send, an **"Approve Send"** button sits to the **right of the schedule field**.
3. Click → **pre-flight validation runs first** (all kickoff refusal reasons: creative attached, credential resolvable, active short domain, recipients > 0, provider api-capable). Spam score is **not** checked here.
4. If pre-flight passes → confirmation popup: **"You're about to submit N messages. Ready?"** (N = audience pool count, known before materializing).
5. On **Yes**:
   - **Future schedule:** materialize immediately (create `stage_sends` rows + mint links), **grey out / lock the schedule field**, mark the stage **armed**. Cron drains it when the window opens.
   - **No schedule (send now):** materialize **and drain inline in the same request**, return the real result.
6. If pre-flight fails → show the specific blocking reasons in the popup; do not materialize.

### ⚠️ Critical landmine — scheduler decoupling (MUST handle)
Today the only signal meaning "don't send yet" is **"no `stage_sends` rows exist."** Phase B drains any tracked stage that has pending rows, **ignoring `scheduled_at`**. The moment you pre-materialize at approve-time, the next `*/15` tick will drain the stage **immediately**, ignoring its schedule.

**Required fix:** decouple materialization-timing from drain-timing.
- `selectDrainableStages` (Phase B) must **additionally require the schedule to be due**: `scheduled_at <= now()` **and** inside the provider's ET send window. A materialized-but-future stage must be skipped by the cron until its time arrives.
- Send-now stages (no `scheduled_at`) are drained **inline at approve-time**, not by the cron — so they don't depend on this predicate at all.

### Abort path (MUST add)
Pre-materialization means an **armed, future-scheduled stage** has live `stage_sends` rows that haven't fired. The operator must be able to **recall** it. Define an explicit abort:
- "Cancel armed send" → discards the pending `stage_sends` rows (or marks them `rejected`), un-arms the stage, **un-greys the schedule** so it's editable again.
- Note today's "un-approve" only clears the gate; with pre-materialization it must also discard pending rows. Don't leave armed stages that can't be recalled.

### Honesty constraint
No async send to a third party is confirmable at click-time — the network calls happen in batches afterward. This flow guarantees everything **structurally checkable** is green before commit, so the only thing that can fail after "Yes" is TextHub rejecting individual messages — which Workstream 3 captures.

### Acceptance
- One operator action (Approve Send → confirm) materializes and arms/sends.
- A future-scheduled armed stage does **not** drain until its window opens (verify the cron skips it).
- A send-now stage drains inline and returns a result in the same request.
- An armed future stage can be fully recalled and rescheduled.
- Schedule field is locked while armed, editable again after abort.

---

## Workstream 3 — Submission integrity, evidence, and classification

**Goal:** Prove our side is clean. Every recipient accounted for, every TextHub response captured as evidence, every failure classified, one-click escalation for anything that's TextHub's.

### Guarantee 1 — Reconciliation (no silent drops)
After materialize + drain, the counts must close:
`pool = attempted + excluded` with a **gap of zero**.
- `excluded` = opt-outs, dedup, and any recipient deliberately not sent — **each with a logged reason**.
- If a pool member became neither an attempt nor a logged exclusion, that's **our bug** — surface it loudly, do not hide it in count math.
- Show the reconciliation on the stage: "Pool 500 = 488 attempted + 12 excluded (12 opt-out). ✓ closed."

### Guarantee 2 — Append-only attempt evidence
Add a **`send_attempts`** table (append-only, one row per attempt) — same pattern as `texthub_inbound_events` / `send_circuit_events`:
- `stage_send_id`, attempt number, timestamp
- **redacted** request (api_key masked)
- **raw response body** (verbatim), HTTP status
- normalized `{ok, messageId, error, status}`
- assigned **classification** (below)

Rationale: today `stage_sends.last_error` is overwritten on retry, destroying the first attempt's evidence. The audit log preserves every attempt. Keep `stage_sends` as the current-state row; `send_attempts` is the history.

### Guarantee 3 — Failure classification
Every failed/non-success row is bucketed:

| Bucket | Meaning | Examples | Owner |
|---|---|---|---|
| **Mine — pre-flight** | never reached TextHub; config error | `no_credential`, `no_short_domain`, `no_creative`, `no_recipients`, `provider_not_api_capable` | us (should be caught by pre-flight) |
| **Mine — transport** | request never connected | DNS fail, connection refused | us |
| **Theirs — rejected** | TextHub returned a rejection envelope | bad number, balance/account, rate-limited, auth rejected | TextHub (escalate) |
| **Indeterminate** | unknown if it landed | stuck `sending` (process died), timeout *after* send, unparseable response | manual reconcile |

**Two structural rules (MUST enforce):**
- **Unparseable → indeterminate, never success.** TextHub's HTTP codes are unreliable (inbox signals via body; registration returns 404 on failure envelopes). The classifier reads the **response body**. Anything it can't confidently parse lands in **indeterminate, flag for review** — never silently counted as sent, never silently bucketed as "theirs."
- **Indeterminate is never auto-retried.** Preserve the existing at-most-once guarantee — a row in `sending` is surfaced for a human, never re-fired. This is what prevents double-sends while a case is being chased.

### Guarantee 4 — TextHub response is the boundary
Once TextHub returns an envelope, our job for that message is done — record their verdict faithfully (raw body + `texthub_message_id`) and move on.

### UI
- **Post-send summary** promoted from toast to a **persistent Activity entry** on the campaign/stage: "488 submitted (accepted by TextHub), 12 failed." (You already write a `send_drain` event — persist and surface it.)
- **Failure banner** (persistent, not a vanishing toast) carrying the classification headline:
  > "12 failed — 9 config (fixable now), 2 TextHub-rejected (escalate), 1 indeterminate (reconcile)."
- **Grouped errors** in the drill-down: group `last_error` / classification so 12 failures read as "9× no_credential, 2× invalid number, 1× timeout," not 12 rows to scan.
- **One-click escalation export** for each *theirs* / *indeterminate* row: recipient number, `texthub_message_id`, timestamp, the exact request sent (**api_key redacted**), TextHub's raw response. This is the packet handed to TextHub; the `texthub_message_id` is their own handle, so it's resolvable on their side without a status endpoint.

### Honest limit
The **indeterminate bucket cannot be eliminated** — a process dying between "sent request" and "recorded response" is genuinely unknown (physics, not a bug). The guarantee is that it's **never hidden**: surfaced as "N indeterminate, reconcile with TextHub," never quietly counted as either outcome.

### Acceptance
- Reconciliation closes to zero on a real run; a forced gap surfaces visibly.
- Every attempt produces a `send_attempts` row with raw body + classification.
- An unparseable response lands in indeterminate, not sent.
- Failure banner shows the mine/theirs/indeterminate split.
- Escalation export produces a complete, key-redacted packet keyed by `texthub_message_id`.

---

## Workstream 4 — Daily-volume UI (ranked by leverage)

1. **Fleet / "Today" dashboard (highest leverage).** One cross-campaign view of every stage scheduled for today and its state — scheduled / armed / sending / done / failed — so triage happens from one screen instead of opening many panels. Pairs with the Workstream 3 failure banners (failed stages surface here first).
2. **Pre-flight readiness checklist on the stage.** Live green/red *before* Approve Send: creative ✓, credential resolvable ✓, short domain active ✓, recipients > 0 ✓, inside send window ✓. **Spam score is shown but is not a checklist gate.** Direct antidote to "will it actually send?" — readiness at a glance instead of a click-time refusal.
3. **Global breaker/pause visibility.** A persistent status strip showing provider `send_paused` state + reason. If a provider is latched paused, every stage says so loudly — no approving sends all day that silently can't fire.
4. **Volume meter against caps.** Today's sent vs `max_sends_per_24h`; this run vs `max_sends_per_run`. See "9,200 / 10,000 today" before committing a big batch.
5. **Send-window indicator on scheduled stages.** "Window opens 08:00 ET" / "open, closes in 3h 12m." Prevents "why didn't it fire overnight" given the sender-ET-zone limitation.
6. **Stuck-row callout.** Rows stuck in `sending` are never auto-retried by design — surface "N stuck, review" prominently rather than leaving them invisible in count math. (Feeds the indeterminate bucket from Workstream 3.)
7. **Per-recipient drill-down with filter + targeted retry.** Filter to failed rows, read the grouped error, retry just those (mints fresh rows per the terminal-row rule — existing "Retry failed" logic, now with visibility around it).

### Acceptance
- The fleet dashboard lists today's stages with correct live state and links into each.
- The readiness checklist reflects real validation results and does not gate on spam.
- Paused provider state is visible globally, not just buried in one panel.

---

## Recommended build order

1. **Workstream 1** (toggle) — small, unblocks live-fire being UI-controlled. Do first.
2. **Workstream 3 surfacing layer** (post-send summary, failure banner, grouped errors) — cheap, mostly UI over data you already write. Build the `send_attempts` table + classification here too if Pre-build step 1 confirms raw body isn't persisted.
3. **Workstream 2** (collapsed Approve Send) — biggest change; requires the Phase B scheduler decoupling, inline send-now drain, and the abort path. Do not start until the scheduler predicate is verified (Pre-build step 2).
4. **Workstream 4** dashboard + readiness checklist + breaker/volume/window/stuck indicators — layer on top once the data and flow are in place.

## Guardrails for the whole build
- Never persist or emit the `api_key` — redact everywhere (attempt log, escalation export, error messages).
- Preserve at-most-once: only `pending` rows are ever claimed; `sending` rows are never auto-retried.
- Keep `kickoffStageSend` / `runStageDrain` operating only on `stage_sends`; respect the existing rule that the pipeline owns `sent_at` for tracked stages.
- Every new migration follows the existing numbering; every schema change updates the `docs/` folder per the standing CLAUDE.md rule.
- UI copy: "Submitted" / "Accepted by TextHub" — never "Delivered."
