# Delivery Report

_Last updated: 2026-09-22_

Delivery-rate visibility across every provider. Three surfaces read from **one**
query layer — [lib/reporting/delivery.ts](../../lib/reporting/delivery.ts) — so
the human view and the automated alert can never disagree:

| Surface | Grain | Where |
|---|---|---|
| `/reports/delivery` | provider × window, expandable to **per number** | [components/reports/delivery-report.tsx](../../components/reports/delivery-report.tsx) · [app/api/reports/delivery/route.ts](../../app/api/reports/delivery/route.ts) |
| `Delivered %` column on the Overview tab | campaign **and** stage | [components/reports/keitaro-report.tsx](../../components/reports/keitaro-report.tsx) · [app/api/keitaro/reports/route.ts](../../app/api/keitaro/reports/route.ts) |
| Undelivered tripwire (check #4) | batch (= stage) | [lib/sends/tells-monitors.ts](../../lib/sends/tells-monitors.ts) · [app/api/cron/tells-monitors/route.ts](../../app/api/cron/tells-monitors/route.ts) |

No schema change. No migration.

---

## 1. Definitions (fixed across every surface)

```
sent        = stage_sends.status = 'sent'      the project's shared definition of
                                               "was messaged" — the same one the
                                               reports rollup, the send breakers
                                               and the sent_from_provider_phone
                                               rule use, so Delivery reconciles
                                               with Overview's Total Sent
delivered   = the message has a terminal 'delivered' receipt
undelivered = terminal 'undelivered' AND NOT delivered      (delivered wins)
no_receipt  = sent AND NOT (delivered OR undelivered)

Delivered %   = delivered / sent      accepted sends as the denominator
Undelivered % = undelivered / sent    the tripwire's rate
```

**`no_receipt` is displayed, never folded into the percentage.** A recently-sent
message may simply not have matured yet; hiding that inside the rate would make
a slow DLR feed look like a delivery failure.

---

## 1b. Grain: `(stage, provider_phone)` — and why the phone is on the primitive

`getDeliveryByStage()` returns one row per **(stage, number)**, and the number
comes from **the send's own `stage_sends.provider_phone_id`**, never from the
stage's current `campaign_stages.provider_phone_id`.

No stage currently sends from more than one number — 0 of 882, across all
2,954,934 sent rows. **That is incidental, not structural:**

- `provider_phone_id` is stamped from the stage row, read **once per
  materialization *invocation*** ([lib/sends/kickoff.ts](../../lib/sends/kickoff.ts))
  and reused across that run's windows;
- materialization is **resumable across invocations** — a budget-capped run
  commits its windows, leaves `materialized_at` NULL, and a later tick re-reads
  the stage row;
- **nothing guards `campaign_stages.provider_phone_id` against being edited in
  between.** The stage `PATCH` locks `scheduled_at` only;
- partially-materialized stages genuinely occur (2 at time of writing).

Edit a stage's number between two windows and its sends legitimately split. If
the phone were derived from the stage, every send in that stage would be
credited to whichever number the stage holds *now* — silently, and precisely on
the number whose deliverability someone was investigating. The split-stage case
is pinned in [scripts/test-delivery-rollups.ts](../../scripts/test-delivery-rollups.ts).

Cost of the wider grain: **+8.4%** (238 ms → 258 ms, measured same-session,
three runs each). No cap change.

**The campaign is still derived from the stage** — that link *is* structural
(FK, exactly one campaign per stage).

`rollupByStage` therefore SUMS a stage's number-rows rather than assuming one.

---

## 2. Capability declaration — why some cells are blank

Report **rows** come from the `sms_providers` registry (every current and future
provider). **Capability** comes from `DLR_SOURCES` in
[lib/reporting/delivery.ts](../../lib/reporting/delivery.ts), whose default is
"no DLR source".

| Provider | Source | Notes |
|---|---|---|
| `tls` | `tells_webhook_events` `kind='dlr'` | key `matched_stage_send_id` |
| `txr` | `textrequest_dlr_events` | key `coalesce(matched_stage_send_id, stage_send_id)` |
| `ahi` | `ahoi_dlr_events` | status arrives **mixed-case**; every source is `lower()`ed |
| `txh` / `txh2` | **none** | TextHub has no DLR table at all (§4) |
| `snx` / `smpl` | **none** | no API send path |

A provider with no source reports its **Sent** count and `null` — rendered `—` —
for Delivered / Undelivered / No receipt / %. **Never `0`.**

**Capability is per-PROVIDER, and every number under it inherits that.** Two
numbers on the same provider can differ sharply in *deliverability* — that is the
entire reason for the per-number breakdown — but never in whether delivery is
*measurable*. The gate is
structural, enforced by the types (`number | null`), not by the UI choosing to
hide a computed zero.

Two consequences, both intended:

- a provider added to the registry tomorrow appears immediately as `—`, needing
  no change to the report;
- when a provider's DLR intake becomes real, registering it in `DLR_SOURCES`
  lights its cells up — also with no change to the report.

---

## 3. Mixed-provider campaigns

A **stage** is always single-provider (verified: 0 of 882 stages with sends span
more than one). A **campaign** can span several.

The campaign-grain percentage is computed over its **DLR-capable sends only**,
and the UI labels the coverage:

```
91.4% (of 4% of sends)
```

`—` when no send in the campaign is DLR-capable. The label is not decoration: a
4%-coverage figure and a 100%-coverage one are otherwise indistinguishable.

> Mixed-**provider** is not the same as mixed-**capability**. All 4 mixed
> campaigns in prod today are `txh` + `txh2` — both non-capable — so they render
> `—`, not a label. No campaign currently mixes a capable provider with a
> non-capable one, so this path is exercised by
> [scripts/test-delivery-rollups.ts](../../scripts/test-delivery-rollups.ts)
> rather than by production data. It starts firing as soon as a `tls`/`txr` stage
> lands in a campaign that also sends via TextHub.

---

## 4. TextHub has no delivery receipts — the important blank

`texthub_inbound_events` (91K rows) is **reply/STOP intake**. It has no status
column and holds no delivery receipts. TextHub's own API does expose a
delivery-report endpoint (`?dlr=true&id=<message_id>`, contract verified in
[scripts/probe-texthub-status.ts](../../scripts/probe-texthub-status.ts)) but
**nothing polls it and nothing stores it**.

`txh` + `txh2` carry ~99.9% of platform volume. Computing delivery for them
without the capability gate produces:

```
txh2   357,567 sent   0 delivered   0 undelivered   0.0%
txh    211,092 sent   0 delivered   0 undelivered   0.0%
```

— which reads as a total platform outage. This is the single reason the gate
emits `null` rather than letting a zero through.

**If a TextHub DLR poller is ever built, registering it in `DLR_SOURCES` is a
deliberate act, not a formality.** Their short-code DLRs are not trusted; do not
register a source whose receipts you have not validated against reality.

---

## 5. Cost — and why the window is capped at 14 days

### The receipt side is bounded by the window (2026-09-22)

Every DLR branch of the `terminal` CTE carries
`received_at >= <window start> − DLR_EARLY_ARRIVAL_MARGIN` (1 hour). Before
that, every call aggregated the **whole receipt history** and only then joined
the window's sends. Text Request went live on 2026-08-20 at ~150K receipt rows
a day, so the cost grew daily. On 2026-09-22 one day's Overview (60,886 sends)
built **1,004,973** txr aggregate groups to use 34,624 of them: 12.9–13.9 s,
~1.3 GB read per load (more than `shared_buffers`, so every load also evicted
the cache), and an 87 MB sort spill.

Why the bound is safe, and why it has a margin and no upper bound:

- **Receipts can land before `sent_at`.** The provider's callback can beat our
  own post-send `UPDATE`. Measured over every tls/ahi receipt and two weeks of
  txr: earliest tls **−14.3 s** (256 rows, 218 terminal), txr **−4.3 s** (51),
  ahi never early, nothing more than a minute early. A zero margin would have
  silently dropped those receipts; 1 hour is ~250× the worst case seen.
- **Receipts arrive late** — txr up to 5 days (reconcile poll), tls 3 days. So
  the bound is lower-only.
- **It relies on `received_at` being stamped at INSERT.** All three sources do
  (column default `now()`; tells passes `new Date()`); `DlrSource` documents the
  requirement for the next one.

`scripts/verify-delivery-received-bound.ts` runs the unbounded reference and the
live query in **one REPEATABLE READ snapshot** and diffs every row. Identical on
2026-09-22 for 1 day, 7 days, 14 days, a 7-day window with all three sources
live (08-15..21), and the tripwire's shape. Re-run it if a provider's timing
behaviour changes.

### Measured cost (prod, 2026-09-22)

Wall-clock, no `EXPLAIN` instrumentation, median of 3 alternating runs on
windows ending yesterday (`stage_sends` 5.45M rows; Small compute, 512 MB
`shared_buffers`):

| Window | Sends | Bounded (now) | Unbounded (before) |
|---|---|---|---|
| 1 day | 60,886 | **523 ms** | 10.4 s |
| 7 days | 419,108 | **16.5 s** | 22.3 s |
| 14 days | 852,251 | **20.2 s** | 25.4 s |

First-touch ("cold") runs on untouched historical windows: 1 day 16.1 s, 7 days
22.2 s. The bound is lower-only, so an **old** window scans every receipt
received since it opened. Windows ending today, which is how the Overview is
used, scan their own slice only.

**Past ~1 day both sides are I/O-bound on this instance, and no query shape
fixes that.** Two alternatives were built and measured on 2026-09-22, then
rejected:

- **Semi-join / `LATERAL` per-send probe over new send-key indexes.** The
  semi-join never used the indexes: for 61K probes the planner prices a
  sequential read lower. `LATERAL` did use them, but it scales with sends:
  7 days took **42 s**. Worse, `textrequest-dlr.ts` and `ahoi-dlr.ts` set
  `matched_stage_send_id` in a post-insert `UPDATE`. Indexing that column made
  **every one of those updates non-HOT** (txr 91% HOT → 0%). The indexes were
  dropped the same day.
- **`EXPLAIN ANALYZE` timings misled.** Per-node instrumentation inflated the
  per-send variants 2–5×. Compare shapes on wall-clock.

The remaining cost is two I/O-bound reads, each sized by the window:

- **Sends:** heap fetches off `stage_sends_org_sent_at_idx`, which doesn't
  carry `status` / `stage_id` / `provider_phone_id` (ClickUp `869ehwae3`).
- **Receipts:** the window's share of the txr heap.

The structural fix for 7–14 day windows is a per-send delivery-state table,
maintained incrementally the way `counted_clickers` is, plus that covering
index. It's tracked as its own card, together with the compute-tier flag.

Therefore:

- `/api/reports/delivery` caps the range at **14 days** (`MAX_RANGE_DAYS`).
- The Overview route permits **92** days, so its `Delivered %` column is
  **computed only when the range is ≤ 14 days**. Beyond that the column reports
  `null` and the UI says why. The Overview reads delivery **in parallel** with
  the funnel instead of after it.
- ⚠️ Since the rollup cutover (§5b) both caps are **kept product limits, not
  cost limits**. The rollup covers all history and reads in ~25 ms at any
  width, so widening either is a product decision rather than an engineering one.

`campaign_stages.sms_count` is **not** a shortcut: it is `0` on all 882 stages
with API sends (a manual-mode field), so `Sent` cannot come from a pre-aggregate.

The live query's cost above is what the tripwire and the nightly
reconciliation pay; the report surfaces no longer do (§5b).

<details><summary>Superseded 2026-08-13 measurement (kept for the record)</summary>

7 days ~832 ms warm / ~2.5 s cold, 30 days 11.0 s — taken when Text Request had
50 sends in total, so the receipt side was ~3 ms. It stopped being true as txr
volume grew; nothing re-measured it until the Overview reached 30 s.
</details>

---

## 5b. The stage delivery rollup (migration 0186) — the report read path

**Status.** Migration 0186 was applied to prod on 2026-09-22, and the backfill wrote 2,122 cells whose `sent` totals match `stage_sends` exactly (5,202,994 sends). The refresh and reconciliation crons have been live since PR #208. **Since the cutover PR, `/reports/delivery` and the Overview's Delivered % column read the rollup** through `getDeliveryByStage` in [lib/reporting/delivery-rollup.ts](../../lib/reporting/delivery-rollup.ts). The tripwire and the reconciliation still read the live `queryDeliveryByStage`. ClickUp `869f5q5au`.

**"As of" and stale.** Both surfaces show how current the cells are, from the two refresh heartbeats in `cron_locks` (`deliveryFreshness`, a pure function with its own test bars):

- a window touching today or yesterday depends on the 10-minute refresh;
- a window touching days 2–6 back depends on the 3-hourly settle;
- the label is the **older** of the stamps the window depends on, because some of its cells may be that far behind;
- a window entirely older than 7 ET days is **final** (its numbers won't change);
- it shows **stale**, in amber, when a stamp it depends on is missing or older than 30 min (refresh) or 7 h (settle). A stale percentage looks exactly like a fresh one, so the flag has to be on the screen.

**Why.** Past ~1 day the live query is I/O-bound on both sides (§5). `stage_delivery_rollup` stores the same four counts per (stage, number, **send ET day**). A report window is then a sum over a few hundred rows: measured on a prototype built from prod data, **22–29 ms for 1, 7 and 14 days** (live: 0.5 s / 16.5 s / 20.2 s), with identical row counts and send totals.

**One definition.** The cells are computed by `refreshDeliveryRollup` ([lib/reporting/delivery-rollup.ts](../../lib/reporting/delivery-rollup.ts)) using the live query's own exported fragments, `terminalCte` and `DELIVERY_COUNTS`. So the per-source fold before the join, `lower()`, delivered-wins, `no_receipt = NOT (d OR u)`, `sent = status 'sent'` and the 1-hour early-arrival margin are shared text, not a copy. Counts are stored for every provider; the `DLR_SOURCES` null-gate stays in the read layer.

**Why the ET day is in the key.** 6 of 2,110 stages ever sent have sent across ET midnight (max span 15 h 40 m, all six in the last month). The live query windows individual *sends*, so without the day those stages couldn't match it whenever a report edge falls between their days. `readDeliveryRollup` sums a day range back to exactly the live (stage, number) rows.

**Refresh — the only writer** (`/api/cron/delivery-rollup`, every 10 min at `:x3`):

| Tier | Cells recomputed | When | Measured cost |
|---|---|---|---|
| A (fresh) | today + yesterday (ET) | every run | ~0.6 s warm / 2.2 s cold per day of stages |
| B (settle) | the last 7 ET days | when the last settle is ≥ 3 h old | ~10 s |

- **Scope is the SEND's day, not the stage.** `campaign_stages.sent_at` is NULL on 3 stages that really sent, and has been re-stamped up to 4 h 12 m after a stage's first send.
- **Cells older than 7 ET days are final.** 0 of 2.64M terminal receipts ever arrived ≥ 6 days after their send (max 5 d 00:02). 99.1% of txr receipts land within a day, so tier B only picks up the late ~1%.
- **One statement per org:** compute, upsert only the cells whose counts changed, delete the ones that vanished (e.g. a send left `sent`).
- Nothing on `stage_sends` or the DLR intake path is written.

**Correctness gates:**

1. [scripts/test-delivery-rollup-db.ts](../../scripts/test-delivery-rollup-db.ts) runs on camman-v2 against a throwaway world. Its expected cells are **derived by hand** from the fixture, not read off the live query, so a defect the two share still fails. It covers: txr dedup, delivered-wins, mixed case, the tls `sent` / `inbound` exclusions, a receipt that lands before its send *and* before the window opens, a midnight straddle, a NULL number, a failed send, skip-unchanged, range isolation, a late receipt, a vanished cell, the foots CHECK and the tier logic.
2. [scripts/verify-delivery-rollup.ts](../../scripts/verify-delivery-rollup.ts), the **snapshot gate**. In ONE `REPEATABLE READ` transaction it refreshes, reads back through the report path, diffs every row against the live query, then **rolls back**. Windows: yesterday, the 7 and 14 days ending yesterday, and 2026-08-15..21 (tls + ahi + txr all live). It prints its scope; zero rows fail. `--persisted` compares what is stored: strictly on frozen windows, informationally on recent ones.
3. `/api/cron/delivery-rollup-reconcile`, **nightly**. It compares the stored rollup with the live query for the 7 frozen ET days ending 7 days ago, in one snapshot, and any diff pages Telegram. Recent days can't be reconciled exactly (receipts land and get matched between the two snapshots), which is why the nightly check uses the frozen window and the gate uses a single snapshot.
4. The refresh job and the reconciliation watch each other's heartbeats (`lib/reporting/cron-heartbeat.ts`). Neither vouches for itself.

**The tripwire stays on the live query** (owner decision, 2026-09-22). It needs a rolling 6 h window, sends at least 10 min old, and fresh data, none of which a day-grain rollup refreshed every 10 min can express. Since #206 the live version is cheap: bounded by `received_at` and restricted to tls stages.

**Deploy order (as done, 2026-09-22):**

1. Apply migration 0186 on prod (manual).
2. Run `npx tsx scripts/backfill-delivery-rollup.ts --apply`. It's idempotent; took 2.6 min for 2,122 cells, ending with the `sent` foot against `stage_sends`.
3. Deploy.
4. Trigger `/api/cron/delivery-rollup`, then `/api/cron/delivery-rollup-reconcile`, to get a first reconciliation result straight away.
5. Watch pgss for the two new statements. The retired `report-rollup` became the #1 DB consumer by rewriting unchanged rows; this one must not.

⚠️ **The mutual watch paged on its first deploy.** The refresh pages if the reconciliation has never run, and the reconciliation pages if the refresh has never run. On 2026-09-22 the reconciliation was triggered first and sent one "rollup is not refreshing — never ran" message (cleared a minute later). **Fixed in #210:** every delivery-rollup heartbeat now has a first-run grace of 2× its interval (20 min / 6 h / 48 h), so "never ran" pages only if a job stays missing that long (see the first-run-grace section of [07-conventions.md](../07-conventions.md)). Running the refresh first is still the quickest way to get a first reconciliation result, but it's no longer what prevents the page.

## 6. Counting traps

Each of these produced a plausible, wrong number during development.

**(a) Row-counting inflates `txr` 3.2×.** Text Request writes a row from the
per-message `status_callback` *and* another from the reconcile poll: 158 event
rows for 50 messages. Counting rows reports 149 delivered against 50 sent —
**298%**. The `GROUP BY` in the terminal CTE must happen **before** the join to
sends.

**(b) "No receipt" ≠ "no event row".** A `tls` message emits a non-terminal
`sent` before `delivered`; a failure emits only `undelivered`. A message with
just the `sent` row *has* an event row and *has no* receipt. Defining no-receipt
as a missing join reported 0 where the truth was 14.

**(c) Ungated computation reads as an outage.** See §4.

---

## 7. Verification

| Script | What it pins |
|---|---|
| [scripts/test-delivery-rollups.ts](../../scripts/test-delivery-rollups.ts) | 45 assertions over the pure aggregators + the tripwire predicate. No DB. Covers the mixed-capability path that prod data does not yet exercise. |
| [scripts/verify-delivery-grains.ts](../../scripts/verify-delivery-grains.ts) | Live: rows foot, the capability gate emits null, the per-message fold dedups, all rollups reconcile. **Prints its input scope**, and warns explicitly when the mixed-capability path was not exercised rather than printing a `0` that reads as a pass. |
| [scripts/test-tells-monitors.ts](../../scripts/test-tells-monitors.ts) | 39 assertions incl. 8 for the tripwire (baseline does not fire, 8.1% does, volume floor holds). |

Per-number breakdown, 7-day window (the motivating case: `txh2` runs a short
code AND a toll-free, collapsed into one row before this change):

```
provider          number         type          sent
txh2             621637         short_code     308,828
txh2             +18446210404   toll_free       36,802
txh              63109          short_code     205,573
tls              +18445694179   toll_free          500
txr              +18449903688   toll_free           50
```

Live figures, 7-day window 2026-08-13:

```
provider        sent   delivrd   undeliv   no rcpt   deliv %
txh2         345,630         —         —         —         —
txh          205,573         —         —         —         —
tls              500       457        29        14     91.4%
txr               50        47         2         1     94.0%
ahi                0         —         —         —         —
```

Both capable rows foot exactly (457+29+14 = 500; 47+2+1 = 50), and the `tls`
5.8% undelivered reproduces the baseline recorded in
[tells-runbook.md](tells-runbook.md) §2b.

---

## 8. The tripwire (check #4)

Runbook §2b — **undelivered > 8% on a matured batch → drop MPS to 10/s, hold
48h** — automated as a fourth check inside the existing
`/api/cron/tells-monitors`, on the shared layer.

- **Batch = stage.** Matured sends only (`DLR_MATURITY_MINUTES` = 10), window 6h,
  floor 50 sends (`DLR_COVERAGE_MIN_SENDS`) — below that a rate is noise, and
  alerting on noise is how a monitor gets muted.
- **Breach-only Telegram**, one line appended to the existing message; the
  undelivered figure is shown on *every* breach so the rate is always visible
  next to a delivery-related alert.
- **DETECTS ONLY.** The MPS response stays manual per the runbook; nothing in the
  monitor writes `provider_phones.max_sends_per_second`.

> ⚠️ **The 8% threshold is calibrated to ONE number** — the `tls` toll-free
> number's 5.8% baseline at 5/s. It is not a platform constant and must not be
> inherited. `txr` and `ahi` have no baseline yet (50 and 1 sends all-time); this
> report is the instrument that will accumulate them, after which each
> DLR-capable provider gets its **own configured threshold** and the check
> generalizes beyond `tls`. Until a provider has a baseline it gets **no**
> threshold, not a default 8%. Path: ClickUp `869ehwae3`.
