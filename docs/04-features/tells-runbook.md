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

### Thresholds are PROPOSED, not calibrated

`INBOUND_SILENCE_MIN_SENDS = 2000`, `DLR_COVERAGE_MIN_RATIO = 0.9`, `DLR_COVERAGE_MIN_SENDS = 50`, `BACKLOG_STALE_MINUTES = 15`. **Calibrate in Phase 5 against observed rates.** A monitor tuned on guesses is a monitor that gets muted.

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

## 6. Go-live status

**`supports_api_send` is `false`.** Phase 5 gates (spec §7): one small live send (~200–500) with DLR coverage verified against the Tells UI; at least one real STOP captured end-to-end into suppression; monitors armed **with thresholds calibrated against observed rates**. Then ramp ~10/s → 30/s over days — **30 is Tells's limit, not a fresh toll-free number's tolerance**. Pacing values need Dmytro's approval.

> **⛔ ZERO-TELLS-VOLUME RULE (in force).** No sends and no manual tests until Phase 4 is live, per the Phase 3 compliance approval. Enabling the gate is a deliberate, audited act via `POST /api/providers/[providerId]/api-send` — it is not settable from the provider form (ClickUp 869ehjwtf).
