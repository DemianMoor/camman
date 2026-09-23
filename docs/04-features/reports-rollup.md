# Reports Rollup

_Last updated: 2026-09-23_

> **⚠️ SOURCE CHANGE (2026-07-20) — read this first.** The five `/reports` tabs
> were re-sourced to **match the Overview (Keitaro) tab exactly**. On first live
> use the tabs read ~7% low vs Overview because they used the per-recipient /
> internal-clicks basis approved in recon (OQ #2/#7/#8); the operator wants the
> numbers they trust. Now:
> - **By Number / By Offer / By Sequence** aggregate the **shared per-stage
>   Keitaro funnel** ([lib/reporting/stage-funnel.ts](../../lib/reporting/stage-funnel.ts)) — the SAME per-stage numbers the Overview route computes, just regrouped → they sum to Overview to the cent.
> - **By Group** distributes each stage's Overview total across its contact groups (tracked: per-contact ⅟k across the groups used in the campaign; manual: by each group's audience share; equal-split fallback) — group rows reconcile back to the stage total.
> - **Hourly** buckets by **user-activity time** (internal event tables) with a pinned **Manual** row — a deliberate different basis (see §Hourly).
>
> **Delivery (added 2026-08-13)** is a SIXTH tab and is deliberately NOT a
> `PerformanceReport` dimension: it has its own route, its own column set
> (delivery receipts, not the EPC/revenue funnel) and its own query layer
> ([lib/reporting/delivery.ts](../../lib/reporting/delivery.ts)). It also backs
> the `Delivered %` column on Overview and the undelivered tripwire — see
> [delivery-report.md](delivery-report.md).
>
> **The Phase-1 rollup below (`report_stage_hour` / `report_group_hour`, the
> `report-rollup` cron, the `stage_sends` snapshot columns) is now UNUSED by the
> reports** — retained but a candidate for a retirement migration. The sections
> below describe that original rollup; the live read layer is §"Read layer + UI".

Pre-aggregated **hourly-bucket** rollup layer originally built to feed five reports
over one shared metric set. **Phase 1** = the data layer (schema, per-send
snapshots, maintenance cron, backfill). **Phase 2** = the read API + UI (the
`/reports` tabs), later re-sourced (see the note above). Full recon + approved
decisions: [`REPORTS-ROLLUP-RECON.md`](../../REPORTS-ROLLUP-RECON.md).

## The five reports & the metric set

Grouped by five dimensions: **by sending number** (provider account), **by
offer**, **by sequence message** (`stage_number`), **hourly** (per ET hour of a
day), **by group** (contact group). Shared metrics per row: total sent, opt-outs
(count + %), clickers (count + %), offer redirects (count + %), sales (count +
%), revenue, cost, EPC, profit. EPC (`revenue / clean clicks`), the extra
`revenue / offer redirects`, profit (`revenue − cost`), and every `%` are
**derived at read time — never stored.**

## Two fact tables ([db/schema.ts](../../db/schema.ts))

Four of the five dimensions (number, offer, sequence, hourly) are functionally
determined by the stage, so they share one grain; only "by group" needs the
many-to-many junction. Hence two tables:

- **`report_stage_hour`** (Fact A) — one row per `(org, stage, ET send-hour)`.
  Feeds reports #1–#4. **Grand totals always come from here.** ~302 rows all-time.
- **`report_group_hour`** (Fact B) — one row per `(org, contact_group, stage, ET
  send-hour)`. Feeds report #5. **Fans out** over `contact_contact_groups` (avg
  1.34 groups/contact, max 6): per-group numbers are truthful per group but sum
  to MORE than the true total by design. **Never sum groups for a total.** ~2,024
  rows all-time.

Both carry denormalized dimension keys (`offer_id`, `brand_id`,
`provider_credential_id`, `provider_phone_id`, `sms_provider_id`, `stage_number`,
`behavioral_tier`, `funnel_stage`, `creative_id`) and additive counters
(`sent_count`, `opt_out_count`, `click_count`, `offer_redirect_count`,
`sales_count`, `revenue`, `cost`) plus `settled` / `refreshed_at`.

## Metric sources (all bucketed by the SEND hour, ET)

Engagement is attributed to the **send's** hour, not the event's own hour, so
every rate is a batch rate ("of messages sent in hour H, X% opted out").

| Metric | Source | Notes |
|---|---|---|
| Sent | `stage_sends` (`status='sent'`) | the spine; `sent_at` → ET hour bucket |
| Opt-outs | `opt_out_attributions.stage_send_id` | unique per (opt-out, stage) |
| Clickers | clean `clicks` via `stage_sends.link_id` | `classification='human' AND scored_at IS NOT NULL` — a DIFFERENT population than the Keitaro visit counter (`campaign_stages.click_count`) |
| Offer redirects | `stage_sends.offer_reached_at` | sent rows only |
| Sales / revenue | **per-recipient** `conversion_events`, joined on `stage_send_id` (`conv_sends`, built from `purchasesBySendSelect()` in [lib/sale-attribution.ts](../../lib/sale-attribution.ts)) | `sales_count` is the COUNT of counted PURCHASE events on the send row — a recipient with two conversions is **two** sales, where `stage_sends.sale_status` kept only the latest — and `revenue` is **APPROVED only**. A rejected or unmapped ledger row counts as nothing. Still bucketed by the SEND hour, so hourly + group attribution is unchanged; ~93% of the authoritative `keitaro_stage_results` daily aggregate |
| Cost | `cost_per_sms × (sent + optouts)` per bucket | flat rate; multi-segment under-costing inherited (separate future card) |

**Snapshot durability (migration 0112).** `stage_sends` gains `provider_phone_id`
+ `cost_per_sms`, stamped at materialization ([lib/sends/kickoff.ts](../../lib/sends/kickoff.ts))
so per-number attribution and per-send cost survive later edits to the stage.
Pre-0112 rows are NULL; the rollup resolves `COALESCE(send snapshot, stage live
value)`.

## Maintenance — bounded rolling-window UPSERT

[`lib/reporting/rollup.ts`](../../lib/reporting/rollup.ts) →
`refreshReportRollup()`. Every run recomputes buckets whose SEND hour is within
the last **14 days** from the base tables and UPSERTs both facts; buckets older
than 14d are frozen (`settled = true`) and never re-scanned. 14d safely covers
every trickle window (opt-out attribution 72h, offer-reach / Keitaro conversion
7d). This is neither a pure append-only watermark (facts UPDATE in place as
engagement trickles in) nor a full matview refresh (which re-scans all history
forever).

- **Cron: UNSCHEDULED as of 2026-07-30.**
  [`app/api/cron/report-rollup/route.ts`](../../app/api/cron/report-rollup/route.ts)
  still exists and is still callable by hand (`maxDuration=60`,
  `preferredRegion=fra1`), but its entry was **removed from
  [vercel.json](../../vercel.json)**, so nothing invokes it automatically and
  **these fact tables are no longer being maintained.**

  Both facts are **write-only** — nothing reads `report_stage_hour` or
  `report_group_hour`. The `/reports` tabs and the Overview route both source
  [`lib/reporting/stage-funnel.ts`](../../lib/reporting/stage-funnel.ts)
  `getStageMetricsInRange()`, and the Telegram report builds from its own
  queries. Meanwhile at `14,29,44,59` this was the **#1 and #2 query by total DB
  time across the entire database** (7,159 s + 6,358 s ≈ 3.75 hours), reading
  ~355 MB per burst to re-upsert ~3,900 live rows 1.7M times — I/O that competed
  with interactive requests. Full four-way verification in
  [creatives-list-slow-stage-picker-2026-07-30.md](../creatives-list-slow-stage-picker-2026-07-30.md) §3.

  **If reporting ever needs these facts, re-add the `vercel.json` entry** (and
  expect a large first catch-up run) rather than building a second copy of this
  logic. Retiring the tables themselves needs a migration + a ClickUp card.

  Previous schedule, for reference: `14,29,44,59 * * * *` — just after the
  opt-out / conversions / offer-reach pollers each quarter-hour so it picked up
  fresh data.
- **Single-runner:** `withCronLease("report-rollup", …)`. The shared `cron_locks`
  row's `watermark` column stores the last-successful-refresh time (lease and
  watermark compose — distinct columns, same row, same as `propagate-clickers`).

## Backfill

[`scripts/backfill-report-rollup.ts`](../../scripts/backfill-report-rollup.ts).
**Default = preflight only** (read-only estimate, no writes). Writing requires
`--apply` + a depth and migration 0112 applied first; idempotent (UPSERT).

```
npx tsx scripts/backfill-report-rollup.ts                 # preflight estimate
npx tsx scripts/backfill-report-rollup.ts --apply --all   # full backfill
```

Preflight output (2026-07-19): 30d → Fact A 282 / Fact B 1,922; 90d & all-time →
Fact A 302 / Fact B 2,024 (data spans ~46 days). Output is trivial at every
depth; the cost is the ~967K-row `stage_sends` scan, which fits one transaction
under 60s.

## Read layer + UI (Phase 2)

The five reports live as **tabs under `/reports`**, alongside the existing Keitaro
funnel (now the **Overview** tab). Each is a child route so the URL is
deep-linkable and the tab/sidebar active state is exact:

- `/reports` → Overview (Keitaro funnel — [components/reports/keitaro-report.tsx](../../components/reports/keitaro-report.tsx), moved out of the page verbatim)
- `/reports/number` · `/reports/offer` · `/reports/sequence` · `/reports/hourly` · `/reports/group` → the five performance reports, all served by [app/(protected)/reports/[dimension]/page.tsx](../../app/(protected)/reports/[dimension]/page.tsx) → [components/reports/performance-report.tsx](../../components/reports/performance-report.tsx)

Shared shell (title + tab bar) in [app/(protected)/reports/layout.tsx](../../app/(protected)/reports/layout.tsx) + [components/reports/reports-tabs.tsx](../../components/reports/reports-tabs.tsx). Nav: a dedicated **Reports** group ([components/protected/nav-config.ts](../../components/protected/nav-config.ts); the sidebar's `isActive` gained an `exact` flag so Overview doesn't light up on sub-routes).

**API:** `GET /api/reports/performance?dimension=<d>&from&to[&provider_phone_id]`
([app/api/reports/performance/route.ts](../../app/api/reports/performance/route.ts)) — gated on `campaigns.view` (same read perm as the Overview tab). Client-safe dimension constants in [lib/reporting/report-dimensions.ts](../../lib/reporting/report-dimensions.ts) (no DB import).

**Operator-API grading fields (2026-09-14).** The route passes every row and `totals` through `gradePerf()` ([lib/reporting/performance-report.ts](../../lib/reporting/performance-report.ts)), adding `clicks_human` (= `counted_clickers`), `click_to_reach_pct`, `reach_to_sale_pct` and `opt_rate` via [lib/reporting/grading-rates.ts](../../lib/reporting/grading-rates.ts) (pure, percent units, `null` when uncomputable). `reached` is a real `PerfMetrics` field: per-recipient `stage_sends.offer_reached_at` counted per stage by REACH day inside `getStageMetricsInRange()` — `null` for a manual-mode stage and skipped when summed, so a row is `null` only when every stage in it is manual. By Group splits it on per-contact reach weights (`trackedWeights(..., "reach")`); Hourly reuses its existing `offer_reached_at` bucket (`reached` = `redirects` there). **Totals dedupe clickers:** `totals.counted_clickers` / `lifetime_clickers` used to be a sum of per-stage counts (double-counting anyone who clicked two stages); they are now distinct (campaign, contact) — the Overview totals-card definition — plus manual stages' Keitaro visits, narrowed to the number when `provider_phone_id` is set. The Reports UI renders neither total, so no on-screen number moved. Spec: [superpowers/specs/2026-09-14-operator-api-grading-design.md](../superpowers/specs/2026-09-14-operator-api-grading-design.md). Definitions: [07-conventions.md](../07-conventions.md) "Grading metrics".

**`attribution` param (2026-09-14).** `conversion_date` (default, unchanged) or `send_date`. `send_date` makes `getStageMetricsInRange()` select the COHORT — stages whose `sent_at` falls in the ET range — and count every Keitaro row, opt-out attribution, reach and send those stages ever produced; manual sales come from `lifetimeManualSalesByStage()` (no window). Period clickers dedupe over exactly the cohort's stages (`CountedClickerBounds.stageIds`, where an empty list returns nothing). `hourly` rejects `send_date` with a 400. A 7-day cohort costs ~10.5s (mostly per-stage send counts, measured 2026-09-14), so the route sets `maxDuration = 60`.

**Tails (2026-09-14).** `GET /api/reports/tails?date=YYYY-MM-DD` ([app/api/reports/tails/route.ts](../../app/api/reports/tails/route.ts) → `getConversionTails()` in [lib/reporting/grading.ts](../../lib/reporting/grading.ts)) splits one `stat_date`'s tracker conversions into same-day (stage sent that ET day), tail (sent on an earlier day — returned as rows by campaign + creative + send day) and unknown send date (no `sent_at`, or one later than the conversion day). The three add up to the day's total by construction. ~10ms.

**Opt-outs (2026-09-14).** `GET /api/reports/opt-outs?dimension=number|campaign|stage|group&from&to&granularity=day` ([app/api/reports/opt-outs/route.ts](../../app/api/reports/opt-outs/route.ts) → `getOptOutCohorts()` in [lib/reporting/grading.ts](../../lib/reporting/grading.ts)) returns the send-day cohort opt-out rate per ET day per dimension value, plus per-day `totals` computed from the sends (group rows overlap and do not add up). One statement: the in-range sends are `MATERIALIZED` once, and sends and distinct STOPs aggregate in separate grouped subqueries joined on (day, key), so there is no `count(DISTINCT send)` sort. `complete` flips once `OPT_OUT_ATTRIBUTION_WINDOW_HOURS` (72) have passed since the day ended. At most 14 days per call — the number dimension measured 11.8s for 7 days (group 4.8s) — and `maxDuration = 60`.

**Creative usage + campaign audit (2026-09-14).** `GET /api/creatives/{id}/usage` ([app/api/creatives/[id]/usage/route.ts](../../app/api/creatives/[id]/usage/route.ts) → `getCreativeUsage()`) returns one row per campaign + sending number + ET send day over the creative's sent stages: `sends`, `clicks_human` (distinct across the row's stages), `reached` (null only for an all-manual row) and tracker `conversions`, plus the campaign's targeted group names; 404 for a creative outside the org; the most-reused creative (80 sent stages) measured 5.3s. `GET /api/campaigns/audit?status=active|paused|completed` ([app/api/campaigns/audit/route.ts](../../app/api/campaigns/audit/route.ts) → `getCampaignAudit()`) returns every campaign in that status with its non-archived stages — `stage_seq`, `split_index`, `behavioral_tier`, stored `status`, scheduled / sent dates, lifetime `sent`, `reached`, `conversions`, `creative_slug` — and campaign `total_conversions`, `revenue` and `last_send_date`, in one request (per-stage counts for all 53 active campaigns measured 568ms). Both in [lib/reporting/grading.ts](../../lib/reporting/grading.ts).

**Send groups + tracker daily sums (2026-09-14).** `GET /api/campaigns/{campaignId}/stages/{stageId}/send-groups?groups=2..10` ([app/api/campaigns/[campaignId]/stages/[stageId]/send-groups/route.ts](../../app/api/campaigns/[campaignId]/stages/[stageId]/send-groups/route.ts) → `getStageSendGroups()` in [lib/reporting/grading.ts](../../lib/reporting/grading.ts)) cuts a stage's sent messages into equal groups by send order (`ntile` over `sent_at, id`; default 2) with per-group `sent`, `reached`, `opt_outs` (attributions on those sends), `clicks_human` (the stage's counted clickers whose send is in the group), `click_to_reach_pct`, `opt_rate` and `first_sent_at` / `last_sent_at`, plus stage-level `pending_sends` and `opt_outs_complete`. No per-group conversions — the tracker is per stage. It replaces the spec's per-hour histogram: a ~4,500-send cell drains in 3–6 minutes, inside one or two clock hours. `GET /api/dashboard/daily-activity?preset=custom&from&to` (already token-reachable) is now documented as the tracker's daily sums: `days[].sales` / `revenue` by ET conversion day, `max(tracker, manual ledger)` per stage-day, archived stages excluded.

**Creative dimension (2026-09-14, operator API only).** `GET /api/reports/performance?dimension=creative` ([app/api/reports/performance/route.ts](../../app/api/reports/performance/route.ts)) groups the shared per-stage funnel by `creative_id × offer_id` — the STAGE's creative (`campaign_stages.creative_id`, now carried on `StageMetrics`) and the campaign's offer — so one creative run on two offers is two rows. Additive metrics are summed; `counted_clickers` / `lifetime_clickers` are distinct at that grain via `getCountedClickersByCreativeOffer()` ([lib/reporting/counted-clickers.ts](../../lib/reporting/counted-clickers.ts)) plus manual-mode visits. Rows add `creative_id`, `offer_id`, `first_sent_date` / `last_sent_date` / `distinct_send_days` (the row's stages sent inside the range) and `rpm` (revenue per 1,000 sent). `offer_id` filters stages, so totals equal that offer's `dimension=offer` row; `min_sent` hides rows (totals unchanged, `hidden_rows` reported); `sortBy` = `revenue` (default) / `rpm` / `sent` / `click_to_reach_pct`, descending with nulls last ([lib/reporting/creative-rows.ts](../../lib/reporting/creative-rows.ts)). `range=lifetime` ignores the 92-day cap and reads an hourly snapshot in `operator_rollups` ([lib/reporting/creative-lifetime.ts](../../lib/reporting/creative-lifetime.ts)), built by `getStageDimensionReports()` from ONE stage-metrics pass per basis for both the creative rows and the per-offer totals. It is deliberately NOT in `REPORT_DIMENSIONS`, which drives the Reports tabs (`API_ONLY_DIMENSIONS` in [lib/reporting/report-dimensions.ts](../../lib/reporting/report-dimensions.ts)). Verified against independent SQL on prod over 2026-09-07..13 (`scripts/verify-creative-report.ts`, 18/18).

**Per-event figures ride the shared metrics (2026-09-19, Phase 5 Task 4 — inert for the UI).** `FunnelTally` ([lib/keitaro/funnel.ts](../../lib/keitaro/funnel.ts)) and `PerfMetrics` ([lib/reporting/performance-report.ts](../../lib/reporting/performance-report.ts)) gained three additive fields, and **no field above them changed meaning**:

- **`events: EventMap`** — the same `sales` / `revenue` / `pending_revenue` split per `event_types.key` (migration 0185), keyed by `key` and never by id. Selected per stage-day out of `keitaro_stage_results.events` and folded by `addRowToFunnel` / `mergeFunnel`.
- **`unmapped: number`** — conversions in scope that matched no mapping, out of `keitaro_stage_results.unmapped_conversions`. In no other field: not in `sales`, not in `revenue`, not in `events`.
- **`manual_topup: number`** — the part of `sales` that came from the MANUAL tally rather than the tracker. It was already computed inside `getStageMetricsInRange()` (`max(0, manualInRange − tally.sales)`) and summed into a local before being discarded; it is recorded because the per-event columns count tracker events only, so it is exactly the gap between `Σ (is_purchase) n` and `sales`. ⭐ **It is a field of `FunnelTally`, not a sibling of it (corrected 2026-09-19).** It first landed on `StageMetrics` beside the tally, which meant `mergeFunnel` carried two of the three terms and every consumer that rendered `events` had to re-roll the third by hand at each grain — `/api/keitaro/reports` did, three times, and nothing would have failed if it had missed one. On the tally it rides the same merge and the same `withFunnelDerived` spread as the breakdown it explains. `addRowToFunnel` deliberately does not touch it (a stored Keitaro row has no manual column): `getStageMetricsInRange` assigns it per stage and copies it onto `grand` explicitly, exactly as it already does for `sales`.

⭐ **`events` alone does not explain Sales**, and the read layer therefore never carries it without the other two — see [07-conventions.md](../07-conventions.md) "A breakdown must travel with the residual that explains it". The identity is `sales = Σ (is_purchase) events[t].n + manual_topup + cross-org strays`, and the strays are what `unmapped` holds.

Every accumulator carries all three: `addRowToFunnel`, `mergeFunnel`, `stageMetrics()` (which COPIES the map — `addEventMaps({}, s.tally.events)` — because one `getStageDimensionReports()` call hands the same `StageMetrics` to several dimensions), `addMetrics()` (non-mutating on both inputs), `scaleMetrics()`, the By-Group fractional split and the hourly tab.

- **By Group** splits the map on **SALE** weights with the documented `?? sentW` re-attribution — the same basis as the `sales` it breaks down, so a group's Registrations and its Sales are built from consistent parts — via `scaleEventMap()`. It cannot use `spread()`, which adds one number into one field. `unmapped` and `manual_topup` have no finer weight by construction and split on SENT; only the page total is exact. Row values are rounded to 2 dp per entry (`roundEventMap`).
- **Hourly** does not read `keitaro_stage_results` at all, so it has its own pass: **`ledgerHourEventQuery()`**, bucketed on `ce.occurred_at` exactly like `ledgerHourQuery()` so the split lands in the same hours as the `sales` and `revenue` series it breaks down. One query answers both questions — `event_key IS NULL` is the unmapped bucket — and the `event_types` join carries `org_id` as well as the id. An **all-zero** entry (a type whose rows in the hour were all rejected) is skipped, matching the projection's own `FILTER`, after the row's `unmapped` count is taken off the same rows. `manualRangeRow` sets `manual_topup = sales` and no breakdown: a manual-mode campaign mints no links and has no tracker conversion at all.
- **Hourly's scalar `pending_revenue` is COMPUTED (2026-09-19).** It was hard-coded to `0` — a "not computed" sentinel — while the same row's `events` carried the real held figures, so one body answered the question twice. `getHourlyReport` now runs a pending series off the same ledger and hour bucket as its approved revenue (`pendingRevenueClause()`), so the scalar and the map agree by construction. Full detail in [conversion-events.md](conversion-events.md) "Hourly had two answers for pending money".
- **`ZERO` is frozen and `zeroMetrics()` exists.** `{ ...ZERO }` is a shallow spread, so every accumulator that mutates its result would otherwise have shared ONE `events` map across requests. See [07-conventions.md](../07-conventions.md).
- **`dimension=creative&range=lifetime` reads a stored blob, so it normalises on read.** `normaliseLifetimeRow()` ([lib/reporting/creative-lifetime.ts](../../lib/reporting/creative-lifetime.ts)) runs `parseEventMap()` over every row, the totals and each `offer_totals` entry, with `?? 0` for the two scalars — a blob written before 0185 has no `events` key at all and `undefined` would otherwise reach the renderer. ⚠️ **After a deploy that endpoint still serves the PRE-DEPLOY blob for up to an hour** (the refresh is `/api/cron/refresh-creative-lifetime`, hourly), during which the generated columns read 0 for every row — indistinguishable from a configured event type with no conversions. Trigger the refresh immediately after deploying, and use the response's `stale_seconds` to tell the two apart.

⚠️ **The funnel's select now needs migration 0185** (`events`, `unmapped_conversions`) in addition to 0182 (`pending_revenue`), which it already needed. Production is still at 0181, so `getStageMetricsInRange()` cannot run there until 0182–0185 are applied. The precondition guard [scripts/_require-migration.ts](../../scripts/_require-migration.ts) refuses on **the whole set** (corrected 2026-09-19 — it checked `pending_revenue` alone, so against a 0182–0184 database a script passed its own precondition and then died on a raw `42703`); its `REPORTING_READ_COLUMNS` list is compared against `stage-funnel.ts`'s own source by bar G1 of [scripts/test-require-migration.ts](../../scripts/test-require-migration.ts), and eight read-path scripts now call it.

**The tables render them (2026-09-19, Phase 5 Task 5 — the first task on a screen).** Both endpoints now emit `event_types` (the registry) beside the rows: `/api/reports/performance` on **all three** response bodies (the `lifetime` branch, the `creative` branch and the default), and `/api/keitaro/reports` on its one. The two report tables generate a column per event type from it — full detail in [conversion-events.md](conversion-events.md) "The report tables render the generated columns". In brief:

- The block is spliced **after `Redir %`, before `Sales`**, located by the neighbouring column's **id** rather than by an index, so no existing column moves relative to its neighbours.
- With production's registry that is seven always-visible columns; three more (the per-event money columns of a `counts_revenue` type) sit behind a per-browser **Event breakdown** toggle, off by default, because each duplicates an aggregate column already on screen.
- ⚠️ **The table already scrolled horizontally before this change, and scrolls further now.** Measured on the live app (`/reports/offer`, camman-v2, 1440px viewport ⇒ 1111px of table container beside the 248px sidebar), before and after on ONE DOM — the "before" figure is the same live table with the seven generated columns removed, so it is a delta and not two estimates: **18 columns → 1405px** (294px of overflow) becomes **25 columns → 2235px** (1124px of overflow). Turning the breakdown on adds three more columns. See [07-conventions.md](../07-conventions.md).
- ✅ **…and since 2026-09-20 the tab opens on a CURATED DEFAULT VIEW of 15 columns** — `[dimension]` · Sent · Landing visits · CR % · Regs · Purchases · Reg→Purchase % · Sales · Revenue · Pending $ · Cost · Human clicks · EPC · Profit · OptOut % — with a per-browser **Show all columns** checkbox beside the Event-breakdown one revealing the other ten (Opt-outs · Redirects · Redir % · Reg rate · Reg pending · Purchase rate · Purchase pending · Sales CR · Human clicks (all time) · EPC (all time)). The toggle changes what is RENDERED and nothing else — no request parameter, no aggregate, no number. Which columns and why, including what a newly configured event type gets: [07-conventions.md](../07-conventions.md) "A curated default view hides columns by KIND, never by key" and [lib/reporting/column-visibility.ts](../../lib/reporting/column-visibility.ts).
- ✅ **The default view now FITS, after the header rename (2026-09-20).** `Clicks (period)` → `Clicks` and `EPC (period)` → `EPC` took those two columns from 108px and 98px to 60px and 56px. Measured in one browser session at a 1440px viewport, `table.scrollWidth` against the same 1126px container: **15 columns, 1165px → 1126px — overflow 39px → 0**, and the container reports no horizontal scroll to offer. The freed width goes to the flexible `Offer` column (75px → 127px), so nothing was dropped to achieve it. The all-columns view is unaffected in kind (25 columns, 1978px) and still scrolls. ⚠️ **Treat this as "one column away from fitting", not as a property of the layout** — a longer offer name or a six-figure Sent count moves it back.
- ✅ **…and it STILL fits after the `Clicks` → `Human clicks` rename (2026-09-20), re-measured rather than assumed.** By Offer default view, real Chromium at 1440px against camman-v2, before and after in ONE session on ONE fixture: **1126px → 1126px in a 1126px container, overflow 0 both times.** The header grows **41px** (60px → 101px) and the flexible `Offer` column gives up exactly that (127px → 86px); nothing was dropped. All-columns goes to **2061px** and scrolls as before. ⚠️ **THE SLACK IS NOW ZERO, AND THE CAVEAT ABOVE IS NO LONGER HYPOTHETICAL — it was measured.** With offer 5 renamed to a 49-character name, the same page reads **1138px — overflow +12px**, because a long value raises the `Offer` column's floor to ~97px and only ~30px of the 41px can be found. The same long name under the OLD header still fits, so the rename is what tips it. Re-measure on a LONG dimension value before adding or widening any column on this table. Full 2×2 and the reasoning: [conversion-events.md](conversion-events.md).
- ⚠️ **…and after the `Clickers` → `Landing visits` rename (2026-09-20) the default view FITS ON AN ORDINARY OFFER NAME AND IS 18px OVER ON A LONG ONE.** Re-measured, not inferred: same real Chromium at 1440px against camman-v2, same 1126px container, By Offer default view, all four cells in ONE session on ONE fixture. **20-char offer name: 1126px → 1126px, overflow 0 (fits). 49-char offer name: 1126px → 1144px, overflow +18px (over).** The header grows 33px (70.7 → 103.7) and the flexible `Offer` column gives up all of it on a short name (112.7 → 79.7) but cannot fall below ~97px on a long one. **Nothing was shortened and no column dropped to make it fit — the owner decides whether 18px of scroll on long offer names is worth the name.** Method control in the same session: *Show all columns* read 2056px in 1126px (overflow 930), so a 1126/0 reading is a real fit rather than an artefact. ⚠️ Note this session also read **1126px / 0** for the 49-char + `Human clicks` case that the bullet above records as **1138px / +12px** — two honest read-backs that disagree, so the fixture's row count and cell content evidently move the `Offer` floor. **Re-measure; never quote a width from this file.**
- ⭐ **The unclassified badge cannot be hidden by it.** `showAllColumns` reaches `EventColumnBlock.columns`; `bar` is built from the response's `totals` where no toggle state is in scope, and `EventColumnsBar` is still mounted unconditionally beside the filters. Seen on screen: the amber `20 unmapped` badge was present in all four toggle states, default view included.
- **Reg→Purchase % is in the default view on the owner's own instruction** — "that ratio is the reason this card exists — it's the first thing I'll look at" — which is also why the generated half of the rule keeps `funnel` alongside `count` rather than counts alone.
- **Overview (the Keitaro tab) is deliberately unchanged** and passes a literal `true`: the curated view was specified for the dimension tabs and `/creatives`, and hiding four of Overview's columns because a shared helper grew a parameter would be a change nobody asked for.
  - ⚠️ **That is also why Overview's 2026-09-23 column change was a REMOVAL, not a hide.** With no toggle on that tab there is nowhere to hide a column to, so dropping `Human clicks` / `Human clicks (all time)` had to be a deletion of the two `ColumnDef`s — plus their ids out of the route's `SORTABLE` whitelist and out of the client's `OVERVIEW_SORTABLE_IDS`, because a persisted sort naming a column nobody can see reorders the table with no indicator. [07-conventions.md](../07-conventions.md) carries the decision and the cost.
- `/api/keitaro/reports` emits **`manual_topup`** on every row, per campaign and on the grand total. It rides `withFunnelDerived`'s spread exactly like `events` and `unmapped` (it is a `FunnelTally` field as of 2026-09-19); the route's three hand-rolled sums are gone.
- `/api/keitaro/results` deliberately selects NEITHER `events` nor `unmapped_conversions`, so it **omits** all three fields rather than emitting `events: {}` / `unmapped: 0` — `addRowToFunnel` folds an absent column into an empty map, and an empty map in a body reads as "measured, nothing happened". `withoutEventBreakdown()` ([lib/keitaro/funnel.ts](../../lib/keitaro/funnel.ts)) deletes them; bar **W20** pins all three response bodies.
- Its sort whitelist gained a **shape** test for generated ids, through `eventColumnById()` — the one parser of that id grammar — rather than a second regex. A null (unknown ratio) sorts **last in both directions**; the same rule runs client-side in the performance tabs.
- ⭐ **Row order (2026-09-23, owner's rules — applies to Overview AND the By-X tabs).** A header click sorts **descending first**, ascending second, and never clears; then **Clickers descending** as a permanent secondary that never flips, whatever the primary column or direction; then a **stable key** (Overview: `campaign_id` then `stage_id`, because `groupBy=stage` makes campaign_id non-unique — By-X: the row's `key`). The key order lives once, in [lib/reporting/report-sort.ts](../../lib/reporting/report-sort.ts) (`makeOverviewComparator` / `makeDimensionComparator`), and the click cycle in [lib/ui/sort-cycle.ts](../../lib/ui/sort-cycle.ts) — opt-in via `DataTable`'s `sortCycle` prop, because that wrapper backs every registry list and they keep `asc → desc → clear`. **Bug fixed in the same change:** both comparators folded the tie-break into `cmp` *before* negating for a descending sort, so the tie-break reversed with the direction. Overview's sort runs **before the page slice**, so its secondary key has to be server-side. 12 bars in [scripts/test-report-sort.ts](../../scripts/test-report-sort.ts) (pure, no DB). See [07-conventions.md](../07-conventions.md).

**Sales does not equal the sum of the purchase columns beside it**, and both tables say so: the `Sales` column header and the `Sales` stat card carry the note, and the card shows `N from the manual tally` when `manual_topup > 0`.

**Data sources (2026-07-20 — match Overview):**
- **Shared per-stage funnel** [lib/reporting/stage-funnel.ts](../../lib/reporting/stage-funnel.ts) `getStageMetricsInRange()` — extracted verbatim from the Overview route ([app/api/keitaro/reports/route.ts](../../app/api/keitaro/reports/route.ts) now calls it too, so Overview and the reports **cannot drift**). Landing visits (headed `Clickers` before 2026-09-20 and, on the **Overview tab only**, `Clickers` again since 2026-09-23 — the owner's naming split, [07-conventions.md](../07-conventions.md); the field is still `clickers`) = `visit_clicks_clean`, Offer Redirect = `redirect_clicks_clean`, Sales = `max(keitaro, manual)` per stage, Revenue = keitaro, Cost = `campaign_stages.total_cost`, Opt-outs = `opt_out_attributions` in range, Sent = per-recipient (tracked) / `sms_count` (manual). Conversion-dated (stat_date).
- **By Number / Offer / Sequence:** group those per-stage metrics by `provider_phone_id` / `campaigns.offer_id` / `stage_number`. Sum → equals Overview.
- **By Group:** [lib/reporting/performance-report.ts](../../lib/reporting/performance-report.ts) `distributeToGroups()` splits each stage's totals across the campaign's used contact groups (`campaigns.audience_contact_group_ids`). Tracked: per-metric weights from per-contact events — each event ⅟k across the contact's used groups (clicks from internal `clicks`, sales from the `conversion_events` purchases of that stage's recipients — `saleWeightCandidates()`, DISTINCT per **contact**, so a recipient's two conversions are one weight — opt-outs from `opt_out_attributions`), applied to the stage's Overview total. ⚠️ A stage with **no** ledger purchase has no sale weights, and its sales/revenue then split on SENT weights instead (the `?? sentW` fallback re-attributes, it never zeroes): the stage total still reconciles, but that row's split answers “who was messaged”, not “who bought”. Manual: by each used group's frozen-audience allocation (`campaign_audience_pool ∩ group`). Equal-split fallback guarantees no metric is dropped. Shares sum to 1 → group rows reconcile to the stage total. Decimals (≤2 dp).
- **Hourly:** `getHourlyReport()` — bucketed by hour-of-day (0–23) **summed across the selected date range** (from/to range like the other tabs). **Sent** (first column) is by SEND hour (`stage_sends.sent_at`, tracked); **engagement is user-activity time** — clicks by `clicks.clicked_at`, redirects by `offer_reached_at`, sales/revenue by **`conversion_events.occurred_at`** (`ledgerHourQuery()` in [lib/reporting/performance-report.ts](../../lib/reporting/performance-report.ts)), opt-outs by `opt_out_attributions.created_at`. **The sales/revenue instant changed with the ledger switch (2026-09-17)**: it was `stage_sends.converted_at`, Keitaro's LATEST re-post time, so a re-post silently moved revenue into a later hour — and out of the range entirely once it crossed ET midnight, changing a report that had already been read. `occurred_at` is the conversion's own time and never moves. Sales/revenue are also now approved-only purchase events, counted per EVENT (a recipient's second conversion is a second sale) and placed by the ledger's `stage_id`, so a conversion whose recipient never resolved can still be bucketed. **% rates** per action use the standard formulas (OptOut%/CR ÷ sent, Redir% ÷ clickers, Sales CR ÷ redirects); because Sent is send-time and engagement is activity-time, a per-hour rate is a **cross-cohort ratio** (an hour with clicks but no sends reads 0%). No cost/EPC/profit (cost is a per-stage lump). A pinned **Manual** row (sorts first) rolls up manual-campaign results with no per-event time (manual `sms_count` sent + manual sales by ledger date + manual-campaign opt-outs) over the range. Hourly deliberately does NOT equal Overview's Keitaro click count — it answers "when do users engage", per operator request.

**UI conventions ([components/reports/performance-report.tsx](../../components/reports/performance-report.tsx)):**
- Default range **today (ET)**; hourly is a single-day picker. Persisted via `usePersistedFilters("reports.performance")`.
- **Overview's exact derivations at read time:** `opt_out_rate = opt_outs/sent`, `CR = clickers/sent`, `redirect_rate = redirects/clickers`, `sales_cr = sales/redirects`, **`EPC = revenue/redirects`**, `profit = revenue−cost`.
- Provider/number filter scopes every tab (stage-level, via `campaign_stages.provider_phone_id`). By-Number rows use the shared [`<ProviderPhoneCell>`](../../components/provider-phone-cell.tsx).
- Totals reconcile to Overview on every tab; group rows sum back to the totals (fractional split, no double-count). Hourly = activity-time engagement (no sent/cost/rates columns).

### Overview campaign cell — send number + capped title (2026-08-28)

The Overview tab's **Campaign** column renders two lines ([components/reports/keitaro-report.tsx](../../components/reports/keitaro-report.tsx)):

- **Line 1 — the campaign name, capped at 50 characters.** Longer names are cut with an ellipsis and the full name moves to the link's `title` (hover). A name at or under the cap gets no tooltip. The cap exists so the now two-line cell doesn't push the metric columns off screen.
- **Line 2 — the send number(s) behind the row**, from `campaign_stages.provider_phone_id`. Long numbers collapse to their last four digits (`…3688`) via `formatPhoneLast4()` ([lib/phone-validation.ts](../../lib/phone-validation.ts)); **short codes render whole** (`621637`) — four digits of a six-digit code identify nothing. Hover shows every number in full, internationally formatted.

Grouped by **stage** the line is that stage's number (absent when the stage has no provider phone). Grouped by **campaign** it is the **distinct** set across that campaign's stages **within the selected range** — the first 3 listed, the rest as `+N` (e.g. `63109, …3688`). The set is assembled in [app/api/keitaro/reports/route.ts](../../app/api/keitaro/reports/route.ts) and travels as `phones: { phone_number, number_type }[]` on every row; the numbers themselves come from a `provider_phones` LEFT JOIN added to `getStageMetricsInRange()` — a join on the PK, so no row fan-out and the funnel math is untouched.

Guard: [scripts/verify-overview-phone-line.ts](../../scripts/verify-overview-phone-line.ts) signs in, calls the real endpoint in **both** groupings, and compares the numbers it returns against `provider_phones` read straight from the DB. It fails loudly if every row comes back with an empty array — all-empty satisfies "has a phones field" and would otherwise pass vacuously.

## Verification

- **Stage funnel (Overview's numbers):** [`scripts/test-stage-funnel.ts`](../../scripts/test-stage-funnel.ts) — **preview-only** (imports `_require-preview-db`, so a bare run refuses instead of reading production) and **builds its own world**: a throwaway org with committed fixtures in a closed window (2026-04-14..15), torn down by org_id with a post-teardown count of 0. Click rows are seeded in the aggregate poll's shape; the conversion columns come from real `conversion_events` rows through the real projection (`syncStageDayConversions`). It proves `getStageMetricsInRange()` (a) returns exactly the seeded grand totals (E1–E12: clickers 72, redirect 22, sales 8 incl. a manual top-up of 4, approved revenue $100, pending $25, unmapped 1, events `{purchase:4, registration:2}`, opt-outs 3, sent 13, cost $6.40; a rejected purchase, a failed send and a decoy day outside the window must not count) and (b) foots Σ stages == grand per metric and per event key (F1–F10). Run with the `.env.demo` `DATABASE_URL`. (Until 2026-09-21 it read production and asserted floors from a Jul 18–19 Overview screenshot, which kept it permanently red on camman-v2.)
- **Reports:** [`scripts/test-performance-report.ts`](../../scripts/test-performance-report.ts) — number/offer/sequence totals **equal** Overview and rows reconcile exactly; group rows reconcile to the totals; hourly buckets by activity time. Plus `tsc` + `next build` (routes compile, client/server boundary clean).
- **Overview campaign cell:** [`scripts/verify-overview-phone-line.ts`](../../scripts/verify-overview-phone-line.ts) — `formatPhoneLast4` unit checks + the live endpoint's `phones` field vs `provider_phones` in the DB (both groupings).
- **Legacy rollup:** [`scripts/test-report-rollup.ts`](../../scripts/test-report-rollup.ts) still validates the (now-unused) Phase-1 rollup aggregates.
- **Operator-API grading fields (2026-09-14):** [`scripts/test-grading-rates.ts`](../../scripts/test-grading-rates.ts) (pure rate math), [`scripts/verify-operator-grading.ts`](../../scripts/verify-operator-grading.ts) (every dimension's `reached` and deduped clicker totals vs independent SQL; read-only on prod), [`scripts/verify-operator-grading-http.ts`](../../scripts/verify-operator-grading-http.ts) (the routes over HTTP with a session, plus a recipient-phone / `contact_id` sweep carrying its own can-go-red controls).
- ⚠️ **By Group is slow at ANY range** (measured 2026-09-14): its click-weight query walks every scored-human click (163K) and probes `stage_sends` once per click — 49s for one day, 55s for two — so with its sibling weight queries running in parallel it intermittently exceeds the 2-minute statement timeout (`57014`). Pre-existing, and `verify-lifetime-display.ts` / `test-performance-report.ts` can hit it. The reach weights run AFTER that parallel batch, not inside it, so they add no contention to it. `verify-operator-grading.ts` reports a By Group timeout as SKIPPED, never as a pass.
