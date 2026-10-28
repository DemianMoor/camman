# Carrier-Rejected Numbers

_Last updated: 2026-10-28 (PR 2: eligibility filters, toggle still off); 2026-10-24 (PR 1: ledger, crons, backfill)_

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
| 1 | Migration 0225, code map, ledger, 15-min + daily crons, backfill, verification | LIVE 2026-10-28 (#403); backfill `MATCH` 24,955 |
| 2 | Eligibility filters: audience (preview/snapshot/draft counts), drip routing (`rejected_by_carriers`), stage materialization | this PR |
| 3 | Settings > Sending UI (toggle, thresholds, code table, live count, CSV), contact detail status | planned |
| 4 | Partner report column | planned |

From PR 2 the toggle is live in every eligibility path (§6). It still ships OFF; the owner turns it on.

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

## 6. Where the toggle applies (PR 2)

ONE definition — [lib/carrier-rejection/eligibility.ts](../../lib/carrier-rejection/eligibility.ts):
a contact is carrier-rejected when its `phone_number` is in `carrier_rejected_phones`
for its org. The toggle is read per call by `isCarrierRejectionSuppressionOn(orgId)`
and passed down as `carrierRejectedSuppression`, a **required** field on
`AudiencePreviewInput`, the draft-count inputs, `StageEligibilityParams`,
`StageEligibilityOverlay` and `evaluateLeadRouting` (read once per routing batch) — CLAUDE.md §11b.

| Path | How | Where |
|---|---|---|
| Campaign audience: preview (whole, base + narrowed parts), activation snapshot, draft stage counts | removed from the audience **source** by `excludeCarrierRejected` — before any count, cap or sample | `buildPreviewMembership` and `buildAudienceSourceSql` / `computeStageAudienceCountForDraft` in [lib/audience-snapshot.ts](../../lib/audience-snapshot.ts) |
| Stage materialization (kickoff), Prepare / preflight, reconcile, CSV export, stage eligibility preview | the `carrier_rejected` layer, **first** in `EXCLUSION_PRIORITY`, outside the `lifecycleRules` gate — every campaign | `buildStageEligibilityExclusions` in [lib/sends/eligibility.ts](../../lib/sends/eligibility.ts); reported as "rejected by carriers" |
| Drip routing | global rule `rejected_by_carriers` = `blocked` ⇒ **permanent** ⇒ the lead is written `unroutable` with that reason | `evaluateLeadRouting` in [lib/drip/routing-eval.ts](../../lib/drip/routing-eval.ts) |

- **Flag off = byte-identical.** `excludeCarrierRejected(rel, org, false)` returns the same
  SQL object; the layer is absent; the drip statement emits no lookup and the verdict has
  no `rejected_by_carriers` key, so stored `unroutable` reasons are unchanged.
- **Source, not a layer, for the audience.** Both audience implementations (the preview
  and the snapshot/draft source) read the source, so they exclude the same people and the
  cap samples only sendable contacts. The source is materialized into the snapshot's
  ANALYZEd temp table, so the extra anti-join never reaches the estimate cascade §10b warns
  about.
- **Not re-checked at send time.** Rows already materialized as pending are left alone
  (owner spec); the drain's lifecycle re-check maps every key explicitly and never reports
  `carrier_rejected`.
- **Stage counts on ACTIVE campaigns** (`computeStageAudienceCount*`, frozen pool) do not
  subtract the layer, the same as the lifecycle layers; materialization does.
- The kill-switch preview (`AUDIENCE_PREVIEW_IMPL=reference`) is frozen and ignores the
  toggle.

## 7. Verification

- [scripts/test-carrier-rejection-codes.ts](../../scripts/test-carrier-rejection-codes.ts)
  — pure; every code seen on prod, with its class.
- [scripts/test-carrier-rejection-ledger-db.ts](../../scripts/test-carrier-rejection-ledger-db.ts)
  — preview DB; hand-derived scenarios (per-message folding, raw_body codes, window,
  reset, Ahoi `error`, thresholds, idempotency, rebuild stale-row removal).
- [scripts/test-carrier-rejection-eligibility.ts](../../scripts/test-carrier-rejection-eligibility.ts)
  — preview DB (PR 2); flag off is the same SQL object; preview == snapshot with the flag
  off (4) and on (2), with a cap, for a lifecycle campaign, and for the two-part preview;
  draft counts; materialization off a pre-toggle pool; the `carrier_rejected` bucket; drip
  `rejected_by_carriers` permanent, absent while off.
- `scripts/test-eligibility-layers-identical.ts` — flag-off byte identity of every
  stage's send SQL and the snapshot qualifier against an origin/main capture (PR 2: 7,469
  shapes, 0 differences, prod 2026-10-28).
- [scripts/verify-carrier-rejections.ts](../../scripts/verify-carrier-rejections.ts) —
  read-only; recomputes the rule from the raw receipts with independent SQL (no import
  of the ledger code) and diffs it against `carrier_rejected_phones`.

Reference point (prod, 2026-10-24, default rule): **24,496** numbers — txr only 23,375 ·
Ahoi + txr 992 · Ahoi only 111 · other combinations 18. Backfill 2026-10-28: `MATCH`
**24,955** — txr 23,870 · Ahoi + txr 957 · Ahoi 110 · other 18; every flagged phone maps
to exactly one contact.
