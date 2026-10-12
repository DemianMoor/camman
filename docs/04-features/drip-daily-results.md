# Drip — Daily results

_Last updated: 2026-10-12 (PR 3: the rollup job, backfill and reconciliation; the tab itself is not built yet)_

Day-by-day performance of one drip campaign, as a table or a chart, on the drip
campaign detail page. Design and owner rulings:
[spec](../superpowers/specs/2026-10-12-drip-daily-results-design.md).

**Status.** Data layer only. The tab and its API arrive in PR 4–5 behind
`org_settings.drip_daily_results_enabled` (migration 0208, default off). PR 4 waits
for the owner's OK on the reconciliation evidence.

---

## 1. Two bases

| basis | a row's ET day is… | a row holds… |
|---|---|---|
| **activity** | the day each event **happened** | sends by `sent_at`, clean clicks by `clicked_at`, opt-outs by the STOP's arrival (`opt_outs.created_at`), sales and approved revenue by **detection** (`conversion_events.created_at`), admissions by `routed_at`, "Leads admitted" by the lead's `lead_events.received_at` |
| **cohort** | the day the lead was **admitted** (`drip_journeys.routed_at`) | everything those leads did since: late sales, follow-ups, opt-outs |

Activity uses the **partner report's** dating rules (owner ruling Q1), so partner
rows over a range sum to that report.

## 2. The rollup — `drip_daily_rollup` ([lib/reporting/drip-daily-rollup.ts](../../lib/reporting/drip-daily-rollup.ts))

Schema and constraints: [03-data-model.md](../03-data-model.md) (`drip_daily_rollup`).

Grain: (campaign, basis, ET day, stage, partner key).
- `stage_id` NULL = the lead row.
- On a stage row, `partner_key_id` NULL = **unattributed**. These are sends with no journey, or whose lead is sandbox. They are kept so a stage's activity cells sum to all of its sends, which is what Overview counts.
- A send with no journey is counted as a **follow-up** (it has no first send).

**Definitions come from the live queries' own fragments, not copies:**

| piece | shared with |
|---|---|
| `journeyForSend()` ([lib/reporting/drip-send-journey.ts](../../lib/reporting/drip-send-journey.ts)): a send → its ONE journey (LATERAL … LIMIT 1) | partner report |
| `terminalCte()` / delivered = `t.d`, denominator = sends on a `DLR_SOURCES` provider | Delivery report, `stage_delivery_rollup` |
| `purchasedClause()` / `approvedRevenueClause()` | partner report, Overview, ledger |
| rate `COALESCE(ss.cost_per_sms, the number's current rate, 0)`; opt-outs at the answered send's rate | partner report, `dripCostByStageInRange` |
| lead-to-send = first send `sent_at − lead_inbox.received_at`, routed-on-arrival leads only (carried 0, never deferred, not sandbox) | `leadToSendLatency` ([lib/drip/lead-latency.ts](../../lib/drip/lead-latency.ts)) |

The median is stored as a fixed log-bucket histogram (`LATENCY_EDGES_SEC`, 29
slots). Ranges and totals sum the histograms; `histogramMedian()` interpolates
inside the bucket. **Never edit the edges**: stored arrays are positional.

### ⭐ The candidate sets are temp tables, ANALYZEd

`prepareCells()` materializes the activity sends, and for the cohort the cohort's
journeys, the candidate sends with their journey, and the joined sends, as
`ON COMMIT DROP` temp tables. Each is `ANALYZE`d before the cell SELECT runs.

As inline CTEs, Postgres estimated the cohort's sends at **1 row** (a LATERAL behind
a DISTINCT join) when there were thousands. It then re-ran the receipt aggregation
once per send, and one day of prod hit a **110 s timeout**. Splitting the candidate
step from the cohort join took the materialization from **44 s to 0.9 s** (prod,
2026-10-12). This is the same trap as the audience snapshot (CLAUDE.md §10b). Any
caller must therefore pass a transaction.

## 3. Refresh — `/api/cron/drip-daily-rollup` (`1,16,31,46 * * * *`)

| tier | scope | when | cost (prod, 2026-10-12) |
|---|---|---|---|
| fresh | today + yesterday, both bases | every run | ~4.5 s warm, ~1M buffer hits, ~0 disk |
| settle | last **14** ET days | once a night, from 05:00 UTC | cold receipts ~830 MB per 3 days (in the quiet slot on purpose) |
| reconcile | the frozen days **15–21** back: stored vs fresh, one REPEATABLE READ snapshot | right after the settle | latched alert `drip-daily-rollup-drift` on any diff |

**Why 14 days.** Measured on prod drip data, things that can still move a past cell:
- sends: ≤ 15 h after admission;
- conversions: detected ≤ 68 h after admission (p99 57 h);
- opt-out attribution: 72 h window;
- late txr `undelivered` callbacks: ~3 days;
- click re-scoring: hours.

14 days is more than 4× the longest. The reconcile is the proof.

**Watchers.**
- `/api/cron/drip-monitors` alerts when the refresh heartbeat (`drip-daily-rollup`) goes stale.
- The refresh run alerts when its nightly stamps go stale (`drip-daily-rollup-settle`, `drip-daily-rollup-reconcile`).

Heartbeats are stamped only when every org refreshed cleanly.

## 4. Backfill and reconciliation

- `scripts/backfill-drip-daily-rollup.ts` (dry run by default, `--apply` writes) works
  through all drip history, test campaigns included, in weekly chunks. It then
  re-diffs every chunk and foots activity sends against `stage_sends`.
- `scripts/verify-drip-daily-rollup.ts <from>..<to> …` is read-only. It checks:
  - **P**: per partner key, the rollup equals the live `getPartnerReport` on sent, send cost, clicks, opt-outs, sales and revenue;
  - **O**: per drip stage, the rollup equals the live `getStageMetricsInRange` (drip ON) on Total Sent, Cost and Opt-outs. Sales and revenue are **reported**, not failed (Overview dates them by `occurred_at`);
  - **L**: lead rows equal hand counts.

## 4b. Money columns — `dailyMoney()` ([lib/reporting/drip-daily-money.ts](../../lib/reporting/drip-daily-money.ts))

Read-time arithmetic over SUMMED cells (owner rulings Q1/Q3, 2026-10-12). One function serves day rows, breakdown rows and the totals row. It is client-safe, so the tab's totals line uses it too.

| column | rule |
|---|---|
| Lookup cost | admitted × `getCalibratedLookupRate()`, the partner report's rate (the reconciliation asserts they are equal). Exact per campaign, because an admitted lead belongs to one campaign. Lookups of leads never admitted, landlines included, stay in the partner report only. A cache-hit lookup cost nothing (~1%), so the column slightly overstates; the tooltip says so. Admissions have no stage, so under **By stage** lookup cost sits on the campaign total only |
| Profit | revenue − send cost − lookup cost (`profitAndRoi`, the partner report's NET) |
| ROI | Profit ÷ (send + lookup cost); `null` ("—") when that cost is 0 |
| Revenue per admitted lead | Cohort only: Σ revenue ÷ Σ admitted; `null` over 0 |

None of these are stored. The rate moves and the partner report reprices with it, so this does too.

The tab shows **"older days updated nightly"**, plus "as of HH:MM ET" for today and yesterday.

## 5. Retention (card 869enz8ge)

Activity cells are permanent, complete per stage (the unattributed bucket),
additive, and frozen after 14 days. Σ over all days = the stage's lifetime sent /
delivered / clicks / opt-outs / sales / revenue / cost. That satisfies the card's
rollup gate **for drip stages only**: regular campaigns are not covered, and other
readers of `stage_sends` would still break (spec §6).

## 6. Tests

- `scripts/test-drip-daily-rollup.ts`: preview DB, rolled back, 38 bars. It covers:
  - pure tier, window and median logic;
  - a hand-built world straddling ET midnight, checked cell by cell for both bases;
  - idempotence, range bounds and vanished cells;
  - the reconciliation diff, including a poisoned-cell red proof.
- `scripts/test-drip-daily-rollup-schema.ts`: migration 0208 constraints.
