# Tells.co — operations runbook

_Last updated: 2026-08-13_

Operational procedures for the Tells (`tls`) SMS provider. Design + verified payload contract: [`docs/superpowers/specs/2026-08-12-tells-provider-design.md`](../superpowers/specs/2026-08-12-tells-provider-design.md) (§5.1 is the contract; §2 is the pre-probe claim and is wrong in eight places).

> ## ⚠️ Why this provider gets its own runbook
>
> Tells has **no reconciliation API and no poll**. Every other provider has a second source to recover from — TextHub has its inbox, Ahoi has the CDR export, Text Request has messages/contacts polls. Tells has nothing.
>
> Combined with STOP-undelivered self-healing being **closed as won't-build** (spec §8), the inbound webhook is the **entire automated STOP surface**. A broken inbound webhook produces **no other symptom**: sends keep succeeding, DLRs keep arriving, dashboards look healthy, and opt-outs pile up unsuppressed until a carrier complaint.
>
> The monitors below are not observability polish. They are the only thing that can notice.

---

## 1. Automated monitors (`/api/cron/tells-monitors`, hourly at `:23`)

Breach-only Telegram, following the EPC monitor pattern — a periodic all-clear trains people to ignore the channel. Logic: [`lib/sends/tells-monitors.ts`](../../lib/sends/tells-monitors.ts).

| monitor | fires when | why it matters |
|---|---|---|
| **Inbound silence** | ≥2000 Tells sends in 24h **and zero** inbound events | The compliance-critical one. STOPs arrive at a predictable rate on any real volume; silence means the intake is broken, not that everyone loves us. |
| **DLR coverage** | <90% of *matured* sends have a terminal receipt (≥50 matured sends) | Either the DLR webhook is failing or Tells stopped calling it. **Not self-healing** — Tells abandons a message's remaining statuses after 4 failed attempts. |
| **Sweeper backlog** | any row unprocessed >15 min (3 sweeper intervals) | If any are inbound, those STOPs are not yet suppressed. |
| **Dead-man (mutual)** | either the monitors or the sweeper stops running | A dead job cannot report itself dead — see §4. |

**Duplicates are reported but NEVER alert** (spec §4.2). A duplicate means either Tells retried (we returned a non-2xx) or we replayed deliberately. Both are worth knowing; neither is an incident.

### ⚠️ The DLR counting rule — do not "fix" this

- a **successful** message emits **2** callbacks: `sent`, then `delivered`
- a **failed** message emits **1**: `undelivered`, with **no preceding `sent`**

So expected events = **`2 × delivered + 1 × undelivered`**, never `2 × messages`. A monitor that assumes two per message reads **every genuine failure as a coverage gap** and fires constantly — which is exactly how a monitor ends up muted.

Coverage itself is therefore measured as **messages with ≥1 terminal event**, which sidesteps the asymmetry entirely. A batch where *everything failed* still has 100% coverage and correctly does **not** breach. Pinned by [`scripts/test-tells-monitors.ts`](../../scripts/test-tells-monitors.ts).

### Thresholds — CALIBRATED 2026-08-13

Derived from the 500-message validation send (stage `8_59_081326_1_s1_c250`), not guessed:

| constant | value | basis |
|---|---|---|
| `INBOUND_SILENCE_MIN_SENDS` | **1200** (was 2000) | observed STOP rate **0.40%** (2/500). Zero STOPs is <1% likely by chance once `N > ln(0.01)/ln(1−0.004) ≈ 1149` |
| `DLR_MATURITY_MINUTES` | **10** (was 30) | terminal-DLR latency p50 **2s**, p99 **9s**, max **401s** (~6.7 min) |
| `DLR_COVERAGE_MIN_RATIO` | **0.90** (unchanged) | observed **96.0%** leaves only 6 points of headroom; raising it converts variance into pages |
| `DLR_COVERAGE_MIN_SENDS` | 50 (unchanged) | volume floor below which the ratio is noise |
| `BACKLOG_STALE_MINUTES` | 15 (unchanged) | 3 sweeper intervals; no backlog observed |

**Observed baseline to compare future batches against:** 500 sent · 451 delivered · **29 undelivered (5.8%)** · 480 with ≥1 terminal event (**96.0% coverage**) · 961 DLR events vs 931 expected · 2 STOPs (0.40%) · 100% DLR correlation via `metadata.stage_send_id`.

These numbers are pinned as a regression fixture in [`scripts/test-tells-monitors.ts`](../../scripts/test-tells-monitors.ts), including the assertion that a naive 2-per-message monitor would have reported a ~4% coverage gap that does not exist.

---

## 2. Weekly reconciliation

**This is the only true reconciliation available for this provider.** Run weekly; it is the manual substitute for the API Tells does not have.

Compare, **for the same calendar day** (ET):

1. **Tells UI send count** vs CamMan `send_attempts` for `tls` (`classification='accepted'`).
2. **Tells UI inbound count** vs `tells_webhook_events WHERE kind='inbound'`.

A gap in (1) means sends are not being recorded; a gap in (2) means **STOPs are being missed** — treat as a compliance incident, not a reporting discrepancy.

```sql
-- CamMan side, one ET day. Compare each against the Tells dashboard.
SELECT
  (SELECT count(*) FROM send_attempts sa
     JOIN stage_sends ss ON ss.id = sa.stage_send_id
     JOIN campaign_stages cs ON cs.id = ss.stage_id
     JOIN sms_providers p ON p.id = cs.sms_provider_id
    WHERE p.sms_provider_id = 'tls'
      AND sa.classification = 'accepted'
      AND (sa.created_at AT TIME ZONE 'America/New_York')::date = DATE '2026-08-13'
  ) AS camman_accepted_sends,
  (SELECT count(*) FROM tells_webhook_events
    WHERE kind = 'inbound'
      AND (received_at AT TIME ZONE 'America/New_York')::date = DATE '2026-08-13'
  ) AS camman_inbound_events;
```

### Duplicate diagnostics (never an alert)

```sql
SELECT count(*) FILTER (WHERE duplicate_count > 0) AS rows_with_duplicates,
       COALESCE(sum(duplicate_count), 0)           AS total_duplicate_count
FROM tells_webhook_events
WHERE received_at > now() - interval '7 days';
```

Non-zero means we returned a non-2xx and Tells retried (it retries **4× at 60s**, then abandons the message's remaining statuses), or we replayed deliberately. Worth understanding, never worth paging.

### Unprocessed backlog

```sql
SELECT kind, count(*), min(received_at) AS oldest, max(process_attempts) AS worst_attempts
FROM tells_webhook_events
WHERE processed_at IS NULL
GROUP BY kind;
```

Anything older than one sweeper interval (5 min) is already alerting. **Rows at `process_attempts >= 10` are no longer retried** and need a human — if any are `kind='inbound'`, those STOPs are unsuppressed.

---

## 2b. Sending rate (MPS) — announce before changing, both directions

**`provider_phones.max_sends_per_second` on the Tells number is not edited silently by anyone — operator or agent. Announce the change and the reason before applying it.**

This rule exists because of a concrete near-miss on **2026-08-13**: the operator raised MPS 5 → 30 in the UI ahead of the validation send; the agent read 30, judged it drift from the approved plan, and reverted it to 5 **1.4 seconds before the send fired**. The send ran at 5/s instead of the intended 30/s. No harm — but the two sides were writing the same field from different assumptions with seconds to spare, and next time the race could land the other way, mid-send, on a fresh toll-free number.

Note the same lost-update shape as ClickUp `869ehjwtf`: the phone edit dialog submits the whole object with no concurrency check, so a stale page can silently restore an old rate. Re-read the current value before assuming what it is.

### Current setting and its tripwire

**MPS = 30/s**, set 2026-08-13 at the operator's explicit decision, overriding the 5→10→15→20→25→30 ladder in the Phase 5 plan.

> ⚠️ **TRIPWIRE: undelivered > 8% on any batch → drop to 10/s and hold 48h.**
>
> Baseline for comparison is **5.8% undelivered at 5/s** on this number. Carrier filtering on a young toll-free number shows up as **undelivered**, not as API errors — the send will look perfectly healthy at the API layer while delivery decays. `undelivered` per batch is therefore the signal to watch, not the send success rate.
>
> ```sql
> SELECT count(DISTINCT e.matched_stage_send_id) FILTER (WHERE lower(e.status)='undelivered')::numeric
>        / NULLIF(count(DISTINCT e.matched_stage_send_id), 0) AS undelivered_rate
> FROM tells_webhook_events e
> JOIN stage_sends ss ON ss.id = e.matched_stage_send_id
> WHERE e.kind = 'dlr' AND ss.stage_id = <STAGE_ID>;
> ```

## 3. Credential rotation — ORDER MATTERS

Rotating either secret in the wrong order drops inbound events, and a dropped inbound event is a dropped STOP.

**Rotating `inbound_webhook_token`** (the path token in the webhook URLs):

1. **FIRST**, update the webhook URL in the **Tells dashboard** to the new token.
2. **THEN** rotate `provider_credentials.inbound_webhook_token` in CamMan.

Doing it the other way round means every callback in between resolves to nothing → `401` → the event is refused, and Tells abandons the remaining statuses after 4 attempts. (Whether Tells accepts more than one webhook URL — which would allow a true dual-token window — is **unknown**; worth checking before the first rotation.)

**Rotating the Tells API key:** the inbound webhook validates the payload `Key` against the stored credential, so update the stored credential **and** the Tells-side key together. A mismatch produces a `401` plus a Telegram alert naming the credential — that alert exists precisely to catch a half-finished rotation.

---

## 4. Mutual dead-man watch

The monitors and the sweeper **watch each other**, because a dead job cannot report itself dead:

- `/api/cron/tells-monitors` (hourly) checks the **sweeper's** heartbeat (`tells-sweep`, stale >1h ≈ 11 missed runs).
- `/api/cron/tells-sweep` (every 5 min) checks the **monitors'** heartbeat (`tells-monitors`, stale >3h ≈ 2 missed runs), rate-limited to **one alert per hour** via its own `cron_locks` watermark — otherwise it would fire 12×/hour and get the channel muted.

Neither vouches for itself. Both stamp `cron_locks.watermark` **after** the work, so a run that threw does not look healthy. (Safe alongside the lease, which writes `lease_until` on the same row — different columns.)

---

## 5. Alerts you can receive, and what each means

| alert | meaning | first action |
|---|---|---|
| `INBOUND SILENCE (compliance)` | STOP intake almost certainly broken | Check the Tells dashboard webhook URL and whether the token was rotated without updating it. Treat as live compliance exposure. |
| `DLR COVERAGE` | delivery receipts missing | Check the DLR webhook URL; remember Tells will not backfill abandoned statuses. |
| `SWEEPER BACKLOG` | rows not draining | Check the sweeper cron is running and inspect `process_error`. |
| `Tells monitors are not running` | the monitors themselves are dead | **Highest priority** — while they are down, a broken inbound webhook produces no symptom at all. |
| `UNRESOLVED TOKEN with a Tells-shaped payload` | an event was **lost** | Almost always a rotation done in the wrong order. The alert body is the event's last copy. |
| `KEY VALIDATION FAILED` | payload `Key` ≠ stored credential | An API key was rotated on one side only. |
| `capture INSERT failed` | the event was **not stored** | The alert body is the last copy. Investigate the DB immediately. |
| `stuck at ≥10 failed attempts` | poison rows, no longer retried | Inspect `process_error`; if inbound, those STOPs are unsuppressed. |

---

## 5b. Validation send — 2026-08-13 (all Phase 5 gates passed)

Campaign `8_59_081326_1`, stage `8_59_081326_1_s1_c250`, 500 recipients, brand Guide Kin, at 5/s.

- **Send:** 500/500 `sent`, zero failures, all `accepted`. 100s for 500 = exactly 5/s.
- **DLR:** 500/500 correlated via `metadata.stage_send_id` — the only handle a Tells DLR carries.
- **STOP, end-to-end:** two *organic* STOPs — `"Stop to END"` and `"Stop"` — both suppressed, contact-matched and **attributed**, writing `opt_outs` with source `tells_inbound_webhook` and moving `campaign_stages.inbound_opt_out_count` to 2. `"Hello"` and `"Start"` were correctly `ignored` (opt-IN is deliberately not handled — see `lib/sends/opt-out-keywords.ts`).
- **§4.6 redaction:** held on all four real inbound payloads — `[REDACTED]` present, API-key last-4 absent from `raw_body`.
- **Cost:** `total_cost` 6.4256 = 500 sends + 2 billed inbound × $0.0128. Inbound is billed; the corrected rate flows through.

## 6. Go-live status

**`supports_api_send` is `false`.** Phase 5 gates (spec §7): one small live send (~200–500) with DLR coverage verified against the Tells UI; at least one real STOP captured end-to-end into suppression; monitors armed **with thresholds calibrated against observed rates**. Then ramp ~10/s → 30/s over days — **30 is Tells's limit, not a fresh toll-free number's tolerance**. Pacing values need Dmytro's approval.

> **✅ LIVE since 2026-08-13.** `supports_api_send = true` (audited), MPS 30/s, cost $0.0128. The zero-volume rule is lifted — it held from the Phase 3 merge until Phase 4 landed and the monitors ticked, exactly as designed. Enabling/disabling the gate remains a deliberate, audited act via `POST /api/providers/[providerId]/api-send`; it is NOT settable from the provider form (ClickUp 869ehjwtf).
>
> **Send-window guard: shipped 2026-08-13** — see §7.

---

## 7. Send window — CLOSED 2026-08-13

**Tells accepts messages at any hour** (confirmed with the vendor, 2026-08-13), so the 09:30–19:30 ET window is enforced *entirely* by CamMan. Today that enforcement is incomplete:

- `lib/sends/scheduled.ts` (the `*/5` auto-send cron) **does** check — `decideScheduledSend` on first fire, `isOutsideSendWindow` on resume.
- **The manual per-stage drain route does NOT check at all.** An operator triggering a drain sends at any hour.
- **The window is not re-checked mid-drain**, so a slice starting at 19:29 runs to completion; the next tick holds it.

So the real guarantee is *"scheduled sends **start** inside the window and are re-held at the next 5-minute tick"* — not *"no message leaves outside it."*

**FIXED.** The drain now re-checks the window before **every batch** (soft stop `outside_send_window` — rows stay pending, nothing latched), and the manual route refuses up front with `409 outside_send_window`. Applies to every provider, not just Tells. A manual drain outside 09:30–19:30 ET now returns a clear error instead of sending.

⚠️ **The send-window columns cannot express "never send."** A degenerate window (`start >= end`, e.g. `0/0`) does **not** disable sending — it falls back to the default 08:00–21:00 ET window, the opposite of what typing it suggests. **To stop a provider sending, pause it** (`send_paused`, the audited latch on the provider page). Since 2026-08-13 the API rejects a degenerate pair at validation with an error pointing at pausing, so this can no longer be set by accident — see [07-conventions.md](../07-conventions.md).
