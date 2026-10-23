# Carrier-Rejected Numbers

_Last updated: 2026-10-24 (PR 1: ledger, crons, backfill; ships dark)_

ClickUp [1amdve2850v](https://app.clickup.com/t/1amdve2850v). Numbers that carriers
repeatedly reject as dead or landline are marked **"Rejected by carriers"** and, while
the org's setting is on, are not used for new sends.

**This is not an opt-out.** Nothing writes `opt_outs`; STOP and compliance handling are
untouched. The rejection state lives in its own derived tables and is applied as an
eligibility filter **only while** `org_settings.carrier_rejection_suppression_enabled`
is on. Turning it off makes the numbers eligible again, with no data lost.

## 1. Status by PR

| PR | Scope | State |
|---|---|---|
| 1 | Migration 0225, code map, ledger, 15-min + daily crons, backfill, verification | this PR |
| 2 | Eligibility filters: audience (preview/snapshot/draft counts), drip routing (`rejected_by_carriers`), stage materialization | planned |
| 3 | Settings > Sending UI (toggle, thresholds, code table, live count, CSV), contact detail status | planned |
| 4 | Partner report column | planned |

Until PR 2 ships, the ledger is computed but **nothing reads it** — the toggle has no effect.

## 2. The rule

- **One outcome per message** (`stage_sends` row). Text Request reports one failure twice
  — a webhook row (code only in `raw_body`: 1002 / 2001 / 2003 / 3000) and a poll row
  (`error_code`: 30003 / 30005 / 30006 / 30008). Both fold to one message, one class.
- A number is **carrier-rejected** when, per org:
  - hard rejections ≥ **hard threshold** (default 2), all time, **or**
  - soft rejections ≥ **soft threshold** (default 3) on messages sent inside the
    **soft window** (default 30 days).
- **A delivered message resets it**: only rejections on messages sent *after* the
  phone's latest delivered message count. The same strict comparison makes
  "delivered wins" for one message that has both receipts.
- Per phone number, org-wide, across regular and drip campaigns and the three
  providers below. Only `stage_sends.status = 'sent'` rows count.

## 3. The code map — [lib/carrier-rejection/codes.ts](../../lib/carrier-rejection/codes.ts)

The ONE place the classes are defined; the ledger SQL is generated from it. Any code
not listed is **ignored**. Ahoi/Tells reasons match lower-cased and trimmed.

| Provider | Hard | Soft | Ignored (listed) |
|---|---|---|---|
| Text Request (`txr`) | 30005 / 2001, 30006 / 2003 | 30003 / 1002 | 30008 / 3000, 30004, 30007, 60005 |
| Ahoi (`ahi`) | Invalid destination address; Teleservice Not Provisioned; Mobile operator not found for the destination address | Absent Subscriber; SM Delivery Failure | Invalid client network; Message canceled; spam-identified; 000 |
| Tells (`tls`) | Unknown or invalid destination number.; Landline or unreachable carrier detected. | Destination handset is unreachable. | Message filtered by carrier.; Network Error |
| TextHub (`txh`, `txh2`) | — excluded entirely: its delivery receipts are fabricated | | |

⚠️ Where each provider puts the failure (measured on prod 2026-10-24):
- **txr**: `status='undelivered'`; poll → `error_code`; webhook → `error_code` is NULL,
  the code is only in `raw_body`.
- **ahi**: `status='error'` (never `'undelivered'`), reason in `error`. The Delivery
  report misses these — ClickUp [1amdve2850w](https://app.clickup.com/t/1amdve2850w).
- **tls**: `status='undelivered'`, reason in `error_message`.

## 4. Data (migration 0225) — see [03-data-model.md](../03-data-model.md#carrier-rejected-numbers-migration-0225)

- `carrier_rejections` — one row per rejected message (hard/soft, canonical code, the
  message's `sent_at`).
- `carrier_phone_delivery` — per phone, the latest delivered message's `sent_at`. This
  is kept as a table because the receipt tables have no index on their stage-send key,
  so "last delivered" cannot be looked up on demand.
- `carrier_rejected_phones` — the numbers meeting the rule right now, with counts.

## 5. Jobs — [app/api/cron/carrier-rejections](../../app/api/cron/carrier-rejections/route.ts)

| Mode | Schedule (UTC) | What it does |
|---|---|---|
| incremental | `5,20,35,50 * * * *` | Receipts received in `(watermark − 1 h, now() − 2 min]`, folded per message and upserted; then a full recompute of `carrier_rejected_phones` (~300K-row ledger) and the watermark advance — one transaction. The 1 h overlap catches Tells receipts, which are matched to their send by `tells-sweep` after insert. |
| `?mode=rebuild` (daily) | `15 4 * * *` (00:15 ET) | Drift repair. Re-derives the ledger from the **last 14 days** of receipts (5 chunks), deletes rejection rows for messages sent inside that window that it did not re-derive, then recomputes the **whole** flagged set. 14 days covers every drift source — Tells receipts matched late, txr receipts landing up to 5 days after the send, a failed tick; older receipts never change. Delivery markers are merged, never lowered. |
| `?mode=full` (on demand) | — | The **initial backfill**, and the repair **after any code-map change**. Re-derives both ledgers from ALL receipt history in 3-day chunks (one transaction each, `SET LOCAL statement_timeout = 300s`), each committing a persisted cursor. **Resumable**: after its 600 s budget it returns `complete:false` and the next call continues; call until `complete:true`. Only then does it delete every row it did not re-derive, `ANALYZE`, recompute the flagged set and **create the watermark** — so the incremental and daily passes refuse until one full rebuild has completed. A run that stops part-way keeps the previous ledger. |

Why the daily job is not full-history: one 3-day chunk of the busiest recent receipts
read in **20 s** on prod (2026-10-24, 155K messages, before writes), and history since
2026-07-16 is ~34 chunks — about 10 minutes of heavy reads every night, growing daily,
for receipts that cannot change.

All modes share one lease (`carrier-rejections`, 14 min), so they never overlap.
**Alerts on failure only**: a Tier-1 Telegram message and a 500. Heartbeats
`carrier-rejections-incremental` (1 h) and `carrier-rejections-rebuild` (50 h, the daily
pass), each with a first-run grace, are watched hourly by `tells-monitors`. A pass that
refuses does not stamp its heartbeat.

**Backfill / code-map change runbook:** `GET /api/cron/carrier-rejections?mode=full` with
the cron secret, repeated until the response says `complete: true`; then
`npx tsx scripts/verify-carrier-rejections.ts` must print `MATCH`.

## 6. Verification

- [scripts/test-carrier-rejection-codes.ts](../../scripts/test-carrier-rejection-codes.ts)
  — pure; every code seen on prod, with its class.
- [scripts/test-carrier-rejection-ledger-db.ts](../../scripts/test-carrier-rejection-ledger-db.ts)
  — preview DB; hand-derived scenarios (per-message folding, raw_body codes, window,
  reset, Ahoi `error`, thresholds, idempotency, rebuild stale-row removal).
- [scripts/verify-carrier-rejections.ts](../../scripts/verify-carrier-rejections.ts) —
  read-only; recomputes the rule from the raw receipts with independent SQL (no import
  of the ledger code) and diffs it against `carrier_rejected_phones`.

Reference point (prod, 2026-10-24, default rule): **24,496** numbers — txr only 23,375 ·
Ahoi + txr 992 · Ahoi only 111 · other combinations 18.
