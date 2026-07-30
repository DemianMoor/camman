# Slow creative loading on the campaign stage — recon + Phase 0/1/3/4 fix

**Date:** 2026-07-30
**Status:** Phases 0, 1, 3, 4 shipped. Phase 2 held pending Phase 0 field data.
**Symptom reported:** opening a stage's creatives view takes ~30s; "brands with many creatives" feel slow, small brands feel fine.

---

## 1. Headline finding

**Creative count is not the cost driver.** The `creatives` table is 193 rows / 48 kB
org-wide, and the expensive work is a fixed org-wide aggregate that runs on every
call regardless of how many creatives come back. A brand with 5 creatives and a
brand with 60 pay the same price.

The cost is in [`/api/creatives/list`](../app/api/creatives/list/route.ts), which
joins a **30-day click aggregate computed across the whole org**:

```
clickAgg = clicks (566K rows in 30d)  ⨝  links (1.84M rows / 319MB heap)
           GROUP BY links.creative_id
```

That subquery is not restricted to the creatives being returned, so `LIMIT`
cannot prune it. `links.creative_id` has **no index** — every other FK on
`links` (`campaign_id`, `stage_id`, `contact_id`, `destination_id`) has one — so
the join is a full sequential scan of the 319 MB heap on every request.

## 2. Measured (prod, Supabase `rtdarhkkjwcetlmruftl`)

| Measurement | Value |
|---|---|
| Full query, offer 62 → 56 rows | **2,567 ms** |
| ↳ `clickAgg` branch alone | **2,504 ms (97.5%)** |
| ↳ `stageAgg` branch | 62 ms |
| Same query, metrics removed | **2.9 ms** |
| Buffers, with → without metrics | **499,566 → 14** |
| `pg_stat_statements` variant 1 | 531 calls, mean **1,272 ms**, max **5,676 ms** |
| `pg_stat_statements` variant 2 | 398 calls, mean 1,131 ms, max 4,846 ms |
| Disk blocks read **per call** | **~31,000 (≈242 MB)** |
| Cumulative DB time on this endpoint | **1,126 s** |

Why it never caches: `shared_buffers` is **512 MB**, the `links` heap alone is
**319 MB**, and Postgres deliberately uses a small ring buffer for large seq
scans — so the scan re-reads from disk every time instead of warming the cache.
`work_mem` is **5 MB** against a hash needing ~120 MB, giving 16 batches and
~59 MB of temp spill per execution.

### Ruled out

- **Payload** — all 180 active creatives total **15 kB** of text (avg 84 chars);
  worst offer yields 56 rows. Never a factor.
- **N+1 in the API** — offers and spam scores are already batched via `inArray`.
- **Creatives-side indexes** — index scan, 0.4 ms.
- **Client render / fetch loop** — 56 rows needs no virtualization;
  `useApiCall.execute` is a stable `useCallback`, so no repeat-fetch loop.

### Contributing factors

- **The stage form paid full price for metrics it never reads.** Its `Creative`
  type ([stage-form.tsx](../components/campaigns/stage-form.tsx)) has no
  `metrics` field — roughly half of the 929 recorded calls were pure waste.
- **Two calls per stage open** — form mount, then picker open.
- **`/api/cron/report-rollup` ran 4×/hour** and was the **#1 and #2 query by
  total DB time in the entire database** (7,159 s + 6,358 s = **3.75 hours**),
  reading ~355 MB per burst, contending for the same disk.
- **No region pin** — functions default to the US while the DB is in
  `eu-central-1`, across ~5 sequential round-trips per request.

### What was NOT explained

DB-side max across 531 calls was **5,676 ms**, not 30 s. Two calls plus cron
contention plus transatlantic round-trips accounts for roughly 10–15 s. The
remainder is unattributed — which is why Phase 0 shipped instrumentation rather
than assuming.

## 3. Shipped

### Phase 0 — attribution that survives

Vercel does not retain runtime logs without a log drain, so historical
per-request timings are unrecoverable. The list route now emits a
**`Server-Timing`** header (`auth`, `rows`, `enrich`, `total`, and a
`metrics;desc="1|0"` mode marker), rendered natively in Chrome DevTools →
Network → Timing. DB time vs. function/round-trip overhead is now readable per
request, permanently, with no extra tooling.

First local samples (dev machine → eu-central-1, so absolute values include
local latency; the split is the point):

```
with metrics    auth 324ms   rows 1997ms   enrich 144ms   total 2465ms
without metrics auth 115ms   rows   57ms   enrich 116ms   total  287ms
```

Note that with metrics off, `auth` + `enrich` (~230 ms) dominate the remaining
`total` — the query stops being the bottleneck. **This is the number that should
decide Phase 2.**

### Phase 1 — stop computing metrics nobody reads

`include_metrics` query param on `/api/creatives/list`, **defaulting to `true`**
so the creatives list page and the picker (both of which sort by and render
EPC/CTR) are untouched. The stage form passes `include_metrics=false`.

When off, the `metrics` key is **omitted entirely** rather than zero-filled — a
0% CTR is a claim, "absent" is the truth. A ratio sort combined with
`include_metrics=false` degrades to `created_at` ordering instead of erroring.

Measured: `rows` **1,997 ms → 57 ms**; end-to-end **2,835 ms → 316 ms**.

Also bundled: `export const preferredRegion = "fra1"` on this route. Note this is
the established **per-route** pattern, **not** a global `regions` field in
`vercel.json` — a global pin would also drag [`/r/[code]`](../app/r/[code]) (the
SMS click redirect, hit by US handsets) away from its users. See
[06-integrations.md](06-integrations.md).

### Phase 3 — retire the dead rollup cron

`/api/cron/report-rollup` removed from `vercel.json`. The route stays callable
manually. Verified unread **four ways**:

1. Repo-wide grep — only writes, in [lib/reporting/rollup.ts](../lib/reporting/rollup.ts), plus `scripts/test-report-rollup.ts`.
2. No `SELECT`/`FROM`/`JOIN` against either table anywhere in `app/` or `lib/`.
3. `/reports` and Overview both source [lib/reporting/stage-funnel.ts](../lib/reporting/stage-funnel.ts) `getStageMetricsInRange()`; the Telegram report builds from its own queries.
4. `pg_stat_user_tables`: `idx_scan` (1,492,814) ≈ `n_tup_upd` (1,491,062) — the apparent "reads" were the upsert's own `ON CONFLICT` probes, not consumers. This is the check a grep cannot do, and it covers external tools too.

The tables themselves are left in place; dropping them needs a migration and a
ClickUp card.

### Phase 4 — two correctness bugs

**Silent truncation.** `parseListParams` clamped `pageSize` to 100 while both
callers requested 200, so an org with >100 eligible active creatives lost the
tail with no indication. `parseListParams(req, { maxPageSize })` now allows an
opt-in higher cap (500 for this endpoint); the picker requests 500 and
**displays a warning** when `data.length < totalCount` instead of hiding it.

**Non-deterministic ordering (found by the new test).** The default sort branch
had no `id` tiebreaker, though the ratio and `spam_score` branches both did and
the comment above them already claimed "Tiebreaker on id keeps pagination
deterministic." Bulk-create commits a batch in one transaction, so **up to 7
active creatives in this org share a `created_at` to the microsecond**. Without
a tiebreaker Postgres may order within a tie group differently per plan — so a
paginated list could show one creative twice and skip another. One-line fix.

## 4. Held — Phase 2

A precomputed `creative_metrics_30d` cache (the aggregate is only 109 rows) or
an index on `links(creative_id)`, or denormalising `creative_id` onto `clicks`.

**Deliberately not built yet.** With Phase 1 in, the only remaining metrics
consumer is the picker, on explicit user action. Adding a cache table + refresh
cron to stabilise a path that may already be fast enough would repeat the
pattern Phase 3 just cleaned up. Decide from the Phase 0 `Server-Timing` data.

## 5. Verification

`npx tsx scripts/test-creatives-list-metrics.ts` — 16/16.
`npx tsx scripts/test-creatives-api.ts` — 49/49 (no regressions).
`npx tsc --noEmit` clean; `eslint` 0 errors, 8 warnings all pre-existing on `main`.
