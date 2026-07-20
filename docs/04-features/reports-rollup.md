# Reports Rollup

_Last updated: 2026-07-20_

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
| Sales / revenue | **per-recipient** `stage_sends.converted_at` / `sale_revenue` | ~93% of the authoritative `keitaro_stage_results` daily aggregate — enables hourly + group attribution; read layer surfaces the reconciliation delta (approved) |
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

- **Cron:** [`app/api/cron/report-rollup/route.ts`](../../app/api/cron/report-rollup/route.ts),
  schedule `14,29,44,59 * * * *` ([vercel.json](../../vercel.json)),
  `maxDuration=60`, `preferredRegion=fra1`. Runs just after the opt-out /
  conversions / offer-reach pollers each quarter-hour so it picks up fresh data.
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

**Data sources (2026-07-20 — match Overview):**
- **Shared per-stage funnel** [lib/reporting/stage-funnel.ts](../../lib/reporting/stage-funnel.ts) `getStageMetricsInRange()` — extracted verbatim from the Overview route ([app/api/keitaro/reports/route.ts](../../app/api/keitaro/reports/route.ts) now calls it too, so Overview and the reports **cannot drift**). Clickers = `visit_clicks_clean`, Offer Redirect = `redirect_clicks_clean`, Sales = `max(keitaro, manual)` per stage, Revenue = keitaro, Cost = `campaign_stages.total_cost`, Opt-outs = `opt_out_attributions` in range, Sent = per-recipient (tracked) / `sms_count` (manual). Conversion-dated (stat_date).
- **By Number / Offer / Sequence:** group those per-stage metrics by `provider_phone_id` / `campaigns.offer_id` / `stage_number`. Sum → equals Overview.
- **By Group:** [lib/reporting/performance-report.ts](../../lib/reporting/performance-report.ts) `distributeToGroups()` splits each stage's totals across the campaign's used contact groups (`campaigns.audience_contact_group_ids`). Tracked: per-metric weights from per-contact events — each event ⅟k across the contact's used groups (clicks from internal `clicks`, sales from `converted_at`, opt-outs from `opt_out_attributions`), applied to the stage's Overview total. Manual: by each used group's frozen-audience allocation (`campaign_audience_pool ∩ group`). Equal-split fallback guarantees no metric is dropped. Shares sum to 1 → group rows reconcile to the stage total. Decimals (≤2 dp).
- **Hourly:** `getHourlyReport()` — **user-activity time**, single ET day, from internal event tables: clicks by `clicks.clicked_at`, redirects by `offer_reached_at`, sales/revenue by `converted_at`, opt-outs by `opt_out_attributions.created_at`. A pinned **Manual** row (sorts first) rolls up manual-campaign results with no per-event time (manual sales by ledger date + manual-campaign opt-outs). Hourly deliberately does NOT equal Overview's Keitaro click count (internal ≠ Keitaro) — it answers "when did users engage", per operator request.

**UI conventions ([components/reports/performance-report.tsx](../../components/reports/performance-report.tsx)):**
- Default range **today (ET)**; hourly is a single-day picker. Persisted via `usePersistedFilters("reports.performance")`.
- **Overview's exact derivations at read time:** `opt_out_rate = opt_outs/sent`, `CR = clickers/sent`, `redirect_rate = redirects/clickers`, `sales_cr = sales/redirects`, **`EPC = revenue/redirects`**, `profit = revenue−cost`.
- Provider/number filter scopes every tab (stage-level, via `campaign_stages.provider_phone_id`). By-Number rows use the shared [`<ProviderPhoneCell>`](../../components/provider-phone-cell.tsx).
- Totals reconcile to Overview on every tab; group rows sum back to the totals (fractional split, no double-count). Hourly = activity-time engagement (no sent/cost/rates columns).

## Verification

- **Overview parity:** [`scripts/test-stage-funnel.ts`](../../scripts/test-stage-funnel.ts) — the extracted helper reproduces Overview to the cent (Jul 18–19: Clickers 2,144, Redirect 257, Sales 32, Revenue $2,040, Cost $747.53, Profit $1,292.47, Sent 72,408) and `sum(stages) == grand`.
- **Reports:** [`scripts/test-performance-report.ts`](../../scripts/test-performance-report.ts) — number/offer/sequence totals **equal** Overview and rows reconcile exactly; group rows reconcile to the totals; hourly buckets by activity time. Plus `tsc` + `next build` (routes compile, client/server boundary clean).
- **Legacy rollup:** [`scripts/test-report-rollup.ts`](../../scripts/test-report-rollup.ts) still validates the (now-unused) Phase-1 rollup aggregates.
