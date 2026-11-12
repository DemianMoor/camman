# Drip — Daily results

_Last updated: 2026-11-12 (late cohort clicks repaired by the reconcile, 0238 trail + nightly guard; start budget 90 s); 2026-11-12 (reconcile range wording fixed to days 14–20; cohort-click drift source documented); 2026-11-11 (nightly settle/reconcile split into units in a 05:00–09:00 UTC window; same-morning alert); 2026-11-05 (columns renamed Leads → Signups, Lead revenue → Signup revenue); 2026-11-04 (0232: Signups + Signup revenue columns, Signups chart line); 2026-10-13 (PR 5: chart view); 2026-10-13 (PR 4: API + table view behind the flag); 2026-10-12 (PR 3: the rollup job, backfill and reconciliation)_

Day-by-day performance of one drip campaign, as a table or a chart, on the drip
campaign detail page. Design and owner rulings:
[spec](../superpowers/specs/2026-10-12-drip-daily-results-design.md).

**Status.** Data layer live (PR 3, backfilled and reconciled 2026-10-13). The
table view (PR 4) and the chart view (PR 5) are both built, and both sit behind
`org_settings.drip_daily_results_enabled` (migration 0208, default **off**).

---

## 1. Two bases

| basis | a row's ET day is… | a row holds… |
|---|---|---|
| **activity** | the day each event **happened** | sends by `sent_at`, clean clicks by `clicked_at`, opt-outs by the STOP's arrival (`opt_outs.created_at`), sales and approved revenue by **detection** (`conversion_events.created_at`), admissions by `routed_at`, "Leads arrived" by the lead's `lead_events.received_at` |
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
| settle | days **2–13** back (with fresh = the last 14 ET days), in **3-day units** per basis (8 units) | nightly, units only inside **[05:00, 09:00) UTC** | cold receipts ~830 MB per 3 days (in the quiet slot on purpose) |
| reconcile | the frozen days **14–20** back, in **2-day units** per basis (8 units): stored vs fresh, one REPEATABLE READ snapshot per unit | same window, after the settle units | late cohort clicks repaired + logged (0238); any other diff → latched alert `drip-daily-rollup-drift` |

**Nightly units (2026-11-11).** Until 2026-11-11 the settle and reconcile ran as ONE
pass, stamped only if the whole pass succeeded. When drip volume grew it stopped
fitting in a run: every attempt was cut off in the reconcile, nothing was stamped,
and every 15-min tick of the working day re-ran the 14-day recompute (~1,200 s of
disk-bound DB time per hour against ~185 s overnight), which slowed campaign
audience previews and stage creation. Now ([lib/reporting/drip-daily-rollup-nightly.ts](../../lib/reporting/drip-daily-rollup-nightly.ts)):
- Each unit has a `cron_locks` row (`drip-daily-rollup-settle:<basis>:<n>`,
  `drip-daily-rollup-reconcile:<basis>:<n>`, `n` = chunk position, 0 = newest):
  `last_run_started_at` = last attempt, `watermark` = done. A run that is cut off
  loses only its current unit.
- `drip-daily-rollup-settle` / `-reconcile` are stamped **independently**, the
  moment that phase's last unit is done.
- A run starts no new unit after **90 s** (`NIGHTLY_RUN_BUDGET_MS`; 120 s until
  2026-11-12, when a run reached ~256 s of its 300 s limit), so a bigger
  night takes more runs, not longer ones. A unit over **90 s** logs
  `[drip-daily-rollup] nightly unit over budget`.
- **Retry cap:** nothing heavy starts outside [05:00, 09:00) UTC, and a failed unit
  waits 60 min before retrying — at most 4 attempts per unit per night, never in
  the working day.
- **Same-morning alert:** a pass still unfinished at 09:00 UTC sends the latched
  Telegram alert `drip-daily-rollup-nightly-incomplete`, naming the pending units.
  It is re-armed at the start of every window, so each failing morning alerts.
  Each failed unit also logs `[drip-daily-rollup] nightly unit failed`.
- The drift alert clears only after a reconcile night with no drift
  (`drip-daily-rollup-reconcile:drift-seen` stamps the night drift was found).
- **Known drift source: cohort clicks (measured 2026-11-12).** The cohort basis counts
  every clean click on a cohort send's link with no time bound, so a click arriving
  more than 14 days after the lead was routed lands in an already-frozen cell. The
  11-12 reconcile found 22 differing cells, all `clicks`, all cohort basis, +39 in
  total; exactly 39 clean clicks had arrived after those days' last settle (none
  re-scored). For cohorts routed 10-06..10-22, 2.7 % of clean clicks came ≥ 14 days
  after routing, 1.0 % ≥ 21 days, 0.16 % ≥ 30 days. The activity basis (dated by the
  click) showed no drift.
- **Late cohort clicks are repaired, not alerted (owner ruling 2026-11-12, option B;
  migration 0238).** A reconcile diff is written back ONLY when it is a cohort-basis
  cell present on both sides whose every counter matches except `clicks`, and fresh
  `clicks` is HIGHER than stored (`classifyCohortClickDiffs`). The write sets only
  `clicks`, only if the cell still holds the old value (`applyCohortClickRepairs`;
  otherwise the unit rolls back and retries), and records each repair in
  `drip_daily_rollup_repairs` (cell key, `old_clicks`, `new_clicks`, `unit_key`,
  `repaired_at`) plus a `[drip-daily-rollup] repaired late cohort clicks` log line.
  Repairs are not drift: a night of only repairs clears `drip-daily-rollup-drift`.
- **Still drift, never repaired:** any other counter (sends, delivered, conversions,
  revenue, …), the activity basis, a missing or extra cell, and stored `clicks`
  ABOVE fresh (`negative` in the run result — not a late click; re-scored or
  removed clicks). These alert exactly as before.
- **Nightly guard.** Per org, if tonight's repairs (from the trail) plus a unit's
  would exceed **60 cells or +150 clicks** (`MAX_NIGHTLY_REPAIR_CELLS` /
  `_CLICKS`), that unit and every later one that night are withheld and the latched
  alert `drip-daily-rollup-repair-guard` fires; it clears on the next night the
  guard does not trip (`drip-daily-rollup-reconcile:repair-guard` stamps the trip).
  Basis: one night of late clicks on days 14–20 back was 1–19 cells / 4–36 clicks
  (nights 10-20 … 11-12, prod); 11-12's reconcile, a week piled up (the size of the
  first night after the change), was 22 / +39.
- **Run result** (`nightly`): `repaired_cells`, `repaired_clicks` (this run),
  `night_repaired_cells` (tonight so far, all runs), `repairs_withheld`,
  `repair_guard_tripped`, `drift`, `negative`.
- **Not covered:** a click more than 20 days after admission lands after the cell
  leaves the reconcile window and is never counted (≈ 1 % of clean clicks for
  cohorts 10-06..10-22).

**Why 14 days.** Measured on prod drip data, things that can still move a past cell:
- sends: ≤ 15 h after admission;
- conversions: detected ≤ 68 h after admission (p99 57 h);
- opt-out attribution: 72 h window;
- late txr `undelivered` callbacks: ~3 days;
- click re-scoring: hours.

14 days is more than 4× the longest. The reconcile is the proof.

**Watchers.**
- `/api/cron/drip-monitors` alerts when the refresh heartbeat (`drip-daily-rollup`) goes stale.
- The refresh run alerts when its nightly stamps go stale (`drip-daily-rollup-settle`, `drip-daily-rollup-reconcile`, ~2 missed nights) — the backstop behind the 09:00 UTC alert above.

The fresh heartbeat is stamped when tier A refreshed every org cleanly, whatever the nightly units do. Tests: `scripts/test-drip-daily-rollup.ts` (pure unit planning + cell maths), `scripts/test-drip-daily-rollup-nightly.ts` (orchestration: budget, retry cap, independent stamps, alerts).

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

## 4b-2. Leads (0232, 2026-11-04)

Two stage counters, `leads` and `lead_revenue`, dated exactly like `sales` and
`revenue` (detection day in Activity, admission day in Cohort):

- **Signups** = lead **and** registration conversions (`reportedRegistrationClause()`:
  a retarget-signal or `counts_as_registration` type, pending + approved). Owner
  ruling 4: one merged number. Labelled "Signups" (owner, 2026-11-05: renamed from "Leads" so it is not confused with "Leads arrived"); the column is still `leads` in the table and API.
- **Signup revenue** (renamed from "Lead revenue" 2026-11-05; still `lead_revenue` in the table and API) = their approved revenue. It is a **breakdown of Revenue**,
  which already contains it (`counts_revenue`), never added again.

⚠️ Not the same thing as **Leads arrived** (partner leads admitted); the column
tooltip says so. Rows written before the 0232 refill read 0. Reports only, no
lane effect ([conversion-events.md](conversion-events.md)).

## 4c. The tab (PR 4)

| piece | where |
|---|---|
| Read layer | [lib/reporting/drip-daily-results.ts](../../lib/reporting/drip-daily-results.ts) `getDripDailyResults()`. It reads **only** `drip_daily_rollup`, plus stage and partner names, change events and two heartbeats. `rowFrom()` builds every row (day, breakdown, totals) from summed cells |
| API | `GET /api/campaigns/[campaignId]/daily-results?basis=&breakdown=&from=&to=` (`campaigns.view`). `?probe=1` returns `{enabled}`. When the flag is off it returns 404 `feature_disabled` |
| UI | [components/drip/daily-results.tsx](../../components/drip/daily-results.tsx), mounted by [components/drip/drip-section-tabs.tsx](../../components/drip/drip-section-tabs.tsx) as **Settings / Daily results** tabs in the campaign page's drip section. When the flag is off the section renders exactly as before |

**Rules the table follows:**
- **Totals row** is pinned first. Day rows run newest first.
- **"Since launch"** is clamped to the campaign's first rollup day.
- **Admissions have no stage.** Under **By stage**:
  - Leads arrived, Admitted and Lookup cost show "—" on stage rows;
  - stage-row Profit and ROI are before lookup cost;
  - lookup cost sits on the campaign total and day rows.
- **Under By partner** lookup cost is attributable, so partner rows carry it. Sends that reach no non-sandbox lead are grouped last as **Unattributed**. On prod on 2026-10-13 there were none: the 5 sends on campaign 994 belong to the `internal-test` key.
- **"Leads arrived"** (leads admitted to this campaign, counted on the day they arrived) is Activity-only. **Rev / admitted** is Cohort-only and shows 4 decimals under $1.
- **ROI shows "—" when the row's send cost is under $1**, on any row (`displayedRoi()`, `ROI_MIN_SEND_COST_USD`). It is a display rule only: the API still returns the computed ROI.
- **Clicks per send can exceed 100% in Activity.** A day's clicks can come from earlier sends, and the tooltip says so.
- **The Day column is sticky** and the table sizes to its content (`w-max min-w-full`), so it scrolls horizontally instead of squeezing or cutting columns.
- **Maturing.** A Cohort row is marked ⧖ until day + `ceil(max drip_followup_minutes / 1440) + 3` days have passed. Follow-up delay is capped at 1,440 min, so that is 3 or 4 days.
- **Change markers (⚑)**, with a tooltip listing each change in ET, come from:
  - `campaign_events`: `drip_config_changed`, `drip_stage_changed`, `campaign_status_changed`;
  - `campaign_circuit_events`: pause / resume.
- **Note line:** "Older days updated nightly · today and yesterday as of HH:MM ET", taken from the `drip-daily-rollup` heartbeat.
- **Persistence:** view, range, preset and breakdown are kept per browser (`usePersistedFilters("campaign.dailyResults")`, try/catch inside).

**Local review against real data:** `DRIP_DAILY_RESULTS_LOCAL_PREVIEW=1 npx next dev` opens the gate on a **local** dev server only. It is ignored whenever `NODE_ENV=production`, which every Vercel deployment uses, previews included. PR previews run on camman-v2, which has no drip campaigns, so this is the only way to see the tab on real campaigns while the org flag is off.

Test: `scripts/test-drip-daily-results.ts` (preview DB, rolled back, 28 bars).

## 4d. Chart view (PR 5) — [components/drip/daily-results-chart.tsx](../../components/drip/daily-results-chart.tsx)

The chart is drawn from the **same API response** as the table; there is no second
endpoint. **Show: Table | Chart** is remembered per browser along with the other
filters. Recharts is loaded through `next/dynamic` only when the chart is chosen,
and the line-metric list lives in `daily-results-metrics.ts` so the picker never
imports it.

| element | rule |
|---|---|
| Bars | Profit per ET day on the **left axis**. With no breakdown, blue = profit and red = loss. Under **By stage** or **By partner** the bar is stacked by group in a **fixed colour order**: the group's stable order (stage number with lanes under their parent, or partner name, Unattributed last), never its rank. Groups past 4 fold into **Other**. Under **By stage** a gray **Lookup cost** segment makes each stack add up to the day's profit. `stackOffset="sign"`, so losses and lookup cost stack **down** from zero |
| Line | ONE metric on the **right axis**, picked from ROI / Clicks per send / Conv % / Opt-out % / Sends / Signups. Straight segments between days (`linear`, not a smoothed curve). ROI uses `displayedRoi()`, so the line has a **gap** wherever send cost is under $1, the same rule as the table |
| Change markers | A dashed vertical line with ⚑ on each day that had a change. The tooltip lists every change for that day in ET |
| Maturing | Cohort bars still maturing are drawn faded (45%) |
| Legend / text | A custom legend: the swatch carries the colour, and the text stays in ink |
| Colours | `--ddr-*` tokens in [app/globals.css](../../app/globals.css): categorical slots 1–4 plus a blue/red profit/loss pair from the dataviz reference palette, with their own dark-mode steps. Validated with the palette checker: light worst colour-blind ΔE 9.1 and normal-vision 22.9, dark 8.4 and 19.8. Two light hues fall below 3:1 contrast; the table view is the relief |

⚠️ **Dual axis is a deliberate owner choice.** The brief asks for "one line metric on a second axis". The dataviz guidance prefers two stacked charts sharing the x-axis. If the dual axis ever confuses readers, that is the alternative to switch to.

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
