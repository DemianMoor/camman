# Reports Rollup

_Last updated: 2026-07-19_

Pre-aggregated **hourly-bucket** rollup layer feeding five reports over one shared
metric set. Phase 1 (this doc) is the **data layer only** — schema, per-send
snapshots, the maintenance job, and the backfill. The five read views / API /
UI land in a later phase. Full recon + approved decisions: [`REPORTS-ROLLUP-RECON.md`](../../REPORTS-ROLLUP-RECON.md).

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

## Verification

[`scripts/test-report-rollup.ts`](../../scripts/test-report-rollup.ts) runs the
exact aggregate SELECTs read-only and asserts totals against the recon baselines
(rows=302, sent=967,281, sales=295, revenue=$20,982, offer-redirects=2,597, Fact
B=2,024, fan-out ≈1.34×). `preSnapshot=true` lets it run before the migration is
applied (the snapshot columns don't change counts).
