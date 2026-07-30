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
per-request timings are unrecoverable. The list route now emits an
**`x-camman-timing`** header (`auth`, `rows`, `enrich`, `total`, and a
`metrics;desc="1|0"` mode marker), readable in DevTools → Network → Headers. DB
time vs. function/round-trip overhead is now readable per request, permanently,
with no extra tooling.

**Not `Server-Timing`.** That was shipped first and found to be **stripped by
Vercel's edge** — present locally, absent in prod. A custom `x-` header passes
through. Cost: no native DevTools Timing-tab rendering.

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

### Region pin — attempted, measured, reverted

`export const preferredRegion = "fra1"` was bundled in, then **removed the same
day after measuring that it does nothing on this project.** Fluid Compute is
enabled (`defaultResourceConfig.fluid: true`), so placement comes from the
project-level `functionDefaultRegions` (`["iad1"]`) and per-route segment
exports are ignored.

Proof, no deploy needed — `x-vercel-id` is `<edge-pop>::<compute-region>::<id>`,
and an unauthenticated 401 still executes the function:

```
/api/clicks/score-pending   401  arn1::iad1::…   (pinned fra1 since 2026-07-13)
/api/opt-outs/poll          401  arn1::iad1::…   (pinned fra1 since 2026-07-13)
/api/creatives/list         401  arn1::iad1::…
/api/brands/list            401  arn1::iad1::…   (never pinned — control)
```

**The five existing fra1 pins have never taken effect either**, including the
2026-07-13 change made specifically to stop two cron routes timing out at the
60s cap. The only lever is the project-level region setting.

### The project-level move to fra1 — DONE, same day

The project setting was changed (`serverlessFunctionRegion` /
`functionDefaultRegions` → `fra1`) and a redeploy issued; the setting applies to
**new deployments only**, so the redeploy is required.

Measured with identical probes before and after:

| | iad1 | **fra1** | |
|---|---|---|---|
| **RTT_db per sequential query** | 187 ms | **2.1 ms** | **89×** |
| `auth` (2 trips) | 344 ms | 28 ms | 12× |
| `rows`, metrics off (1 trip) | 190 ms | 5.1 ms | 37× |
| `enrich` (2 trips) | 377 ms | 10.0 ms | 38× |
| **list call total** | **917 ms** | **43 ms** | **21×** |
| picker total | 2,200 ms | 1,047 ms | 2.1× |
| `/r/` probe wall (from Poland) | 352 ms | 76 ms | 4.6× |

**`/r/[code]` was the reason this looked risky, and it turned out to be the
strongest argument FOR the move.** The redirect makes **2 sequential DB round
trips** — link lookup, then click insert (strictly dependent, both awaited) — for
**0.861 ms** of actual DB work (`0.469` + `0.392`, over 423K calls each). From
`iad1` that was ~374 ms of pure network per click. Nothing is cached or deferred:
`force-dynamic`, `/r/` is excluded from the proxy matcher (so no auth trip), and
`classifyClick` is pure UA/prefetch heuristics with real scoring deferred to a
cron.

TLS terminates at the **edge PoP**, not the function region — measured TCP
connect 14 ms / TLS 68 ms from Poland, which would be ~110 ms / ~330 ms if the
handshake had to reach `iad1`. So the region move does **not** change handshake
cost; only the PoP→function hop moves. For a US handset that trades two
transatlantic DB crossings (~374 ms) for one PoP→fra1 hop (~90 ms):
**~400 ms → ~115 ms**.

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

## 4. Phase 2 — the metrics cache (ClickUp 869ebvkr4)

**Why it was still needed after the region move.** Colocation removed the
round-trip tax but not the work: on `fra1` the picker's `rows` segment was
**990 ms of which only ~2 ms was network**. The aggregate is CPU/IO-bound inside
Postgres, so no amount of proximity helps.

### Indexing was evaluated first and rejected ON MEASUREMENT

Candidate indexes built inside a transaction and rolled back, against live prod:

| Candidate | Execution |
|---|---|
| Baseline (no new index) | 1,394 ms |
| `links(creative_id)` — the card's literal suggestion | **1,592 ms — worse** |
| `links(id) INCLUDE (creative_id) WHERE creative_id IS NOT NULL` | 1,488 ms — worse |
| `links(creative_id, id) WHERE creative_id IS NOT NULL` | 990 ms — 1.4×, for a 58 MB index |

**No index can help**: the query has no selective predicate. It must touch every
click in the 30-day window and map each one to a creative, so it is an inherently
full-scan aggregate. Indexes buy selectivity; there is none to buy. The best
variant still leaves the picker at ~1 s while adding 58 MB of index for every
link insert to maintain.

### Shape: in-memory, read-driven — [lib/creatives/metrics-cache.ts](../lib/creatives/metrics-cache.ts)

A module-level cache keyed by `org_id`, 15-minute TTL, with single-flight so N
concurrent requests on one instance trigger one query. On a miss it computes both
aggregates in a **single** round trip (`FULL OUTER JOIN`, because a creative can
have stage activity with no tracked clicks or vice versa) and the route injects
the result as a literal `VALUES` relation. That keeps the SQL shape identical —
the four ratios are still computed and **sorted server-side across the whole
filtered set**, so ordering and pagination are unchanged; only the *source* of
the counters moved.

**Deliberately NOT a cache table + refresh cron.** A timer-driven refresh burns
DB time whether or not anyone is looking — precisely how `report_stage_hour`
became the #1 consumer of DB time in this database with zero readers (§3). This
cache is refreshed **by reads**: if nothing asks for metrics, nothing is ever
computed, so it structurally cannot become a dead rollup. It also needs no
migration, which matters because the unmerged `feat/textrequest-send` branch
already claims `0121`–`0124`, and `verify-migration-integrity` validates
`snapshot.prevId` by journal index — a second migration chained off `0120` would
break that chain on merge.

Trade-off accepted: the cache is per-instance and does not survive a deploy or an
instance recycle, so a cold instance pays one recompute. Strictly better than
before, where *every* request paid it.

## 5. Verification

- `scripts/test-creative-metrics-cache.ts` (new) — **10/10**. The load-bearing
  assertion is #1: every creative's served metrics are compared against a **live
  recomputation of the original inline aggregate**, so a silent numeric
  regression can't hide. Also asserts ratios derive from their own base counts,
  `mcache;dur` is ~0 ms on a warm hit (proving the cache is *consulted*, not
  recomputed per request), ratio sort is still server-side and monotonic with
  nulls last, and paginating a ratio sort produces no duplicates or skips.
- `scripts/test-creatives-list-metrics.ts` — 16/16.
- `scripts/test-creatives-api.ts` — 49/49 (no regressions).
- `npx tsc --noEmit` clean; `eslint` 0 errors.
