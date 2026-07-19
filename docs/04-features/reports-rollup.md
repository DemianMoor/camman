# Reports Rollup

_Last updated: 2026-07-19_

Pre-aggregated **hourly-bucket** rollup layer feeding five reports over one shared
metric set. **Phase 1** = the data layer (schema, per-send snapshots, maintenance
cron, backfill). **Phase 2** = the read API + UI (the `/reports` tabs). Both are
live. Full recon + approved decisions: [`REPORTS-ROLLUP-RECON.md`](../../REPORTS-ROLLUP-RECON.md).

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
- `/reports/number` · `/reports/offer` · `/reports/sequence` · `/reports/hourly` · `/reports/group` → the rollup reports, all served by [app/(protected)/reports/[dimension]/page.tsx](../../app/(protected)/reports/[dimension]/page.tsx) → [components/reports/performance-report.tsx](../../components/reports/performance-report.tsx)

Shared shell (title + tab bar) in [app/(protected)/reports/layout.tsx](../../app/(protected)/reports/layout.tsx) + [components/reports/reports-tabs.tsx](../../components/reports/reports-tabs.tsx). Nav: a dedicated **Reports** group ([components/protected/nav-config.ts](../../components/protected/nav-config.ts); the sidebar's `isActive` gained an `exact` flag so Overview doesn't light up on sub-routes).

**API:** `GET /api/reports/performance?dimension=<d>&from&to[&provider_phone_id]`
([app/api/reports/performance/route.ts](../../app/api/reports/performance/route.ts)) — gated on `campaigns.view` (same read perm as the Keitaro tab). Reads the rollup via [lib/reporting/performance-report.ts](../../lib/reporting/performance-report.ts) (`getPerformanceReport` + `getReportProviderOptions`); returns raw counters + display labels + true totals + provider options. Dimension constants are in the client-safe [lib/reporting/report-dimensions.ts](../../lib/reporting/report-dimensions.ts) (no DB import — safe to import from client components).

**UI conventions honored:**
- **Default range = today (ET);** the hourly tab is a single-day picker. Range persisted via `usePersistedFilters("reports.performance")`.
- **EPC / profit / percentages derived at read time** in the client (`derive()`), never stored.
- **Provider/number filter** (a `<Select>` of the numbers present in the rollup) scopes every tab. The **By Number** report renders each row with the shared [`<ProviderPhoneCell>`](../../components/provider-phone-cell.tsx) — extracted from the campaigns list column so both stay identical.
- **Totals always come from Fact A** even on the group tab; a footnote states group rows fan out and don't sum to the total.
- **Reconciliation note (approved):** a footnote states sales/revenue are per-recipient attribution (~93% of the Keitaro total on Overview) — the two bases will differ.
- "Data as of …" freshness stamp from `max(refreshed_at)`.

## Verification

- **Data layer:** [`scripts/test-report-rollup.ts`](../../scripts/test-report-rollup.ts) runs the exact aggregate SELECTs read-only and asserts totals against the recon baselines (rows=302, sent=967,281, sales=295, revenue=$20,982, offer-redirects=2,597, Fact B=2,024, fan-out ≈1.34×). `preSnapshot=true` lets it run before the migration is applied.
- **Read layer:** [`scripts/test-performance-report.ts`](../../scripts/test-performance-report.ts) exercises `getPerformanceReport` for all five dimensions against live data — additive dims sum to the true total, the group dim correctly fans out above it, provider options + ET hour labels resolve. Plus `npx tsc --noEmit` + `next build` (routes compile, client/server boundary clean).
