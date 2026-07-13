# CamMan v2 — Phase 0 Diagnostic Recon

**Date:** 2026-07-13
**Scope:** READ-ONLY diagnostic. No code, data, schema, or settings were changed.
**Environment measured:** production Supabase (`rtdarhkkjwcetlmruftl`, PostgreSQL 17.6, transaction pooler :6543 `prepare=false`), and the live code tree at `c:\AFF\camman`.
**Compute:** recently upgraded Nano → Small. This report targets what compute cannot fix.

> **Rating key.** Each finding is rated for **(a) impact on today's speed** and **(b) impact on 5M-contact viability**, each `CRITICAL / HIGH / MEDIUM / LOW`.

---

## Framing fact that colours the whole report

There is **exactly one organization** (`b0ce3435-…`) holding **all 752,707 contacts**. Every `WHERE org_id = …` filter the code relies on for selectivity — in indexes, snapshots, counts — currently narrows nothing. Multi-tenant index designs are effectively **full-table** designs here. This is not a bug (the schema is correct for multi-tenancy) but it means: **any query "scoped by org" is a full-table query today**, and will stay that way until there are many orgs. Plan v2 rollups and partitioning as if org_id gives zero selectivity.

Second framing fact: **the heavy tables scale with SENDS, not with contacts.** Contacts is nearly flat (+164/day, 0 in the last 7 days). The billion-row risk is the append-only **event tables** (`stage_sends`, `links`, `send_attempts`, `creative_exposures`, `clicks`), each already ~745K rows after ~40 days of history and growing 24–34K rows/day. "5M contacts" matters mostly because one full-base campaign then writes **5M rows into each of four event tables at once**.

---

## §1 — Database Size & Growth

Total database size: **2,117 MB**. 97 user tables. 1 partitioned table, 2 materialized views (tiny on disk; expensive to refresh — see §5).

### 10 largest tables (`pg_total_relation_size`)

| # | Table | Est. rows | Total | Heap | Indexes | Notes |
|---|-------|-----------|-------|------|---------|-------|
| 1 | `stage_sends` | 744,566 | **450 MB** | 255 MB | 195 MB | 12 indexes, 195 MB of them; 143K dead tuples |
| 2 | `send_attempts` | 733,080 | **402 MB** | 342 MB | 59 MB | one row per send attempt; pkey (16 MB) never used for reads |
| 3 | `contacts` | 752,707 | **349 MB** | 117 MB | **231 MB** | index size is 2× the heap — heavy index bloat/overlap |
| 4 | `links` | 744,627 | **268 MB** | 129 MB | 139 MB | one link minted per recipient per send |
| 5 | `creative_exposures` | 717,913 | **184 MB** | 58 MB | 126 MB | ledger; indexes 2× heap |
| 6 | `contact_contact_groups` | 892,330 | **155 MB** | 65 MB | 89 MB | junction; one 35 MB index used 3× total |
| 7 | `clicks` | 276,729 | **99 MB** | 71 MB | 27 MB | growth ~9K/day |
| 8 | `campaign_audience_pool` | 393,367 | **62 MB** | 26 MB | 36 MB | frozen per-campaign snapshots; no timestamp col |
| 9 | `offer_exposures` | 237,942 | **59 MB** | 19 MB | 40 MB | ledger; indexes 2× heap |
| 10 | `opt_outs` | 68,531 | **22 MB** | 7 MB | 14 MB | suppression source, hottest anti-join target |

### Daily growth (bucketed by `created_at`, last 7d / 30d)

| Table | rows/day (7d) | rows/day (30d) | last-30d | total | history since |
|-------|--------------:|---------------:|---------:|------:|---------------|
| `links` | 31,972 | 24,788 | 743,625 | 744,627 | 2026-06-03 |
| `stage_sends` | 31,972 | 24,788 | 743,625 | 744,581 | 2026-06-03 |
| `send_attempts` | 34,328 | 24,436 | 733,078 | 733,078 | 2026-06-16 |
| `creative_exposures` | 34,051 | 23,900 | 716,997 | 717,891 | 2026-06-03 |
| `clicks` | 12,989 | 9,215 | 276,464 | 276,738 | 2026-06-03 |
| `offer_exposures` | 9,266 | 7,947 | 238,413 | 239,305 | 2026-06-03 |
| `opt_outs` | 702 | 1,313 | 39,382 | 68,531 | 2026-05-26 |
| `contacts` | **0** | 164 | 4,915 | 752,707 | 2026-05-18 |
| `contact_contact_groups` | 0 | 104 | 3,118 | 892,330 | 2026-05-18 |
| `phone_lookups` | 71 | 17 | 500 | 500 | 2026-07-10 (new: Telnyx) |

**The tables that will define v2 are append-only and have NO retention or partitioning.** The entire event history is ~40 days old and already ~2 GB. Per-row footprint (incl. indexes): `stage_sends` ≈ 634 B, `send_attempts` ≈ 574 B, `links` ≈ 377 B, `clicks` ≈ 373 B, `creative_exposures` ≈ 269 B.

### Projection to 5M contacts

Two views, because sends — not contacts — drive these tables:

**(a) Steady-state, if daily send volume scales 6.6× with the contact base (752K → 5M):**

| Table | ~rows/day @5M | ~rows/yr | ~disk/yr (incl idx) |
|-------|--------------:|---------:|--------------------:|
| `stage_sends` | ~164K | ~60M | **~38 GB/yr** |
| `send_attempts` | ~161K | ~59M | **~34 GB/yr** |
| `links` | ~164K | ~60M | **~22 GB/yr** |
| `creative_exposures` | ~158K | ~58M | ~16 GB/yr |
| `clicks` | ~61K | ~22M | ~8 GB/yr |

**(b) The sharp edge — a single full-base campaign at 5M contacts** writes, in one activation/send cycle: **5M `campaign_audience_pool` + 5M `stage_sends` + 5M `links` + 5M `send_attempts` + 5M `creative_exposures`** rows ≈ **~10–12 GB written per full-base campaign**, versus ~1.6 GB today. With the stated target of 100+ campaigns/day, even a fraction hitting the full base means **tens of GB/day of append-only writes**.

- **Impact today:** LOW (2 GB is comfortable on Small).
- **Impact at 5M:** **CRITICAL** — unbounded append-only event tables with no partitioning/retention are the central v2 architecture problem. Index-maintenance cost, autovacuum load, and per-campaign write bursts all grow with total history.

---

## §2 — Slow Queries (`pg_stat_statements` **is enabled**)

`pg_stat_statements` is installed and populated. Top offenders below (deduped across "by total time" and "by mean time"). Percentages are share of total DB exec time captured in the view.

### The dominant offender

| Rank | Query | Calls | Mean | Total | % of DB time |
|------|-------|------:|-----:|------:|-------------:|
| 1 | **`INSERT INTO clickers … SELECT DISTINCT ON … WHERE NOT EXISTS(…clickers…)`** | 1,729 | **8,004 ms** | **13,839,744 ms** | **30.3%** |

**One query is ~30% of all database time.** It is the "propagate tracked clickers" job (`lib/links/propagate-clickers.ts:39-85`), fired every 15 min by `/api/clicks/score-pending`. Confirmed by EXPLAIN: the predicate `WHERE classification='human' AND scored_at IS NOT NULL` has **no supporting index → Parallel Seq Scan of the full `clicks` table** every run, then a 4-table join + `GROUP BY` + a `NOT EXISTS` anti-join against `clickers` (which also lacks a composite `(org_id, contact_id, brand_id, source, offer_id)` index). It **re-derives all 22,538 all-time human clicks on every run to insert ~15,218 rows** — cost scales with total history, not with new clicks. See §3 and §5.

- **Impact today:** **HIGH** (single biggest DB consumer; 8 s/run every 15 min).
- **Impact at 5M:** **CRITICAL** (a full-`clicks` seq-scan at 22M+ rows every 15 min inside a 60 s function).

### Other top offenders (by total time)

| Query (abridged) | Calls | Mean | Total | Table(s) | Scan / trigger |
|---|---:|---:|---:|---|---|
| audience count `select count(*) … from campaign_audience_pool p join contacts c … row_number()` | 1,108 | 1,706 ms | 1,890,057 ms | audience_pool ⋈ contacts | live audience preview/count |
| geoip `SELECT data, downloaded_at … fresh …` | 729 | 1,738 ms | 1,266,894 ms | `geoip_cache` | ~8 MB bytea fetch on cold start (see §6) |
| creatives list `select "creatives".* …` (14,517 rows) | 379 | 3,310 ms | 1,254,314 ms | `creatives` (+join) | page load / stage picker |
| `UPDATE stage_sends … FROM (VALUES …)` (send status) | 9,041 | 129 ms | 1,161,443 ms | `stage_sends` | send drain writes |
| `UPDATE campaign_stages … total_cost = …` | 9,472 | 120 ms | 1,134,881 ms | `campaign_stages` | cost recompute on writes |
| audience tier count `… MAX(tier) … clean click tier` | 231 | 4,208 ms | 972,097 ms | pool ⋈ clicks ⋈ links ⋈ stage_sends | live lane/tier count |
| **`REFRESH MATERIALIZED VIEW CONCURRENTLY offer_group_report_mv`** | 20 | **27,622 ms** | 552,445 ms | matview base scan | cron (twice-daily) |
| `select count(*) … from stage_sends where status=$ and sent_at ∈ [range]` | 161 | 3,281 ms | 528,155 ms | `stage_sends` | monitoring/report throughput |
| `UPDATE stage_sends SET status … FOR UPDATE SKIP LOCKED LIMIT` | 15,580 | 30 ms | 469,455 ms | `stage_sends` | drain claim (healthy) |
| `INSERT INTO send_attempts … VALUES (…)` | 14,334 | 31 ms | 441,346 ms | `send_attempts` | send writes |
| **`… UPDATE contacts SET carrier_norm … WHERE carrier_norm=$ … FOR UPDATE SKIP LOCKED`** | 17 | **23,633 ms** | 401,766 ms | `contacts` (752K) | Telnyx carrier backfill (full-table) |
| segment audience `with unionized … segment_contacts … contact_contact_groups` | 31 | **13,340 ms** | 413,534 ms | segment eval | segment preview/snapshot |
| `SELECT count(*) FROM stage_sends WHERE org_id=$ AND sent_at > now()-interval` | 31,778 | 12 ms | 369,451 ms | `stage_sends` | per-batch rate-limit check (very frequent) |

### Highest **mean-time** queries (≥5 calls)

| Mean | Query | Calls |
|-----:|-------|------:|
| 27,622 ms | `REFRESH MATERIALIZED VIEW CONCURRENTLY offer_group_report_mv` | 20 |
| 23,633 ms | `UPDATE contacts SET carrier_norm …` (Telnyx backfill, full table) | 17 |
| 13,340 ms | segment `unionized` audience eval | 31 |
| 8,476 ms | `DELETE FROM contacts WHERE org_id=$` | 15 |
| 8,004 ms | propagate-clickers INSERT | 1,729 |
| 7,836 ms | audience count with opt-out `NOT EXISTS` | 11 |
| 7,502 ms | `REFRESH … offer_report_org_summary_mv` | 20 |
| 6,523 ms | `INSERT INTO campaign_audience_pool … SELECT` (snapshot) | 20 |
| 6,246 ms | segment count (manual ∪ rules) | 7 |
| 5,552 ms | per-stage `stage_sends` group-count (multi-stage IN list) | 8 |

**Observations.**
- Aggregates over `campaign_audience_pool`, `stage_sends`, and the segment-eval CTEs dominate the read side; all are **live, computed at request time**, and all sit in the 1.7 s–13 s band.
- The two matview refreshes (27.6 s and 7.5 s) and the Telnyx carrier backfill (23.6 s) are the heaviest single statements, all cron/maintenance.
- Write path (`stage_sends`/`send_attempts` inserts+updates) is individually cheap (30–130 ms) but very high frequency.

- **Impact today:** **HIGH** (multiple multi-second queries on interactive paths).
- **Impact at 5M:** **HIGH→CRITICAL** (each live aggregate scales with pool/send size).

---

## §3 — Index Audit

### Seq-scan hotspots (high seq_scan or high seq_pct on non-trivial tables)

| Table | rows | seq_scan | idx_scan | seq_pct | seq_tup_read | Query pattern that suffers |
|-------|-----:|---------:|---------:|--------:|-------------:|----------------------------|
| **`clickers`** | 15,218 | **92,757,735** | 41,538 | **100%** | 13.99B | Something scans `clickers` ~92.8M times with no usable index — the propagate anti-join / lookups by non-indexed predicate (`source`, or composite). **Worst ratio in the DB.** |
| `segment_contacts` | 50,549 | 5,302,670 | 2,516,036 | 67.8% | 86.7M | segment eval `WHERE segment_id=` on a table whose main index is the pkey `(segment_id, contact_id)` — but membership scans still fall to seq |
| `stage_result_rows` | 18,792 | 833,286 | 39,555 | 95.5% | 3.9M | small table repeatedly scanned in import/report path |
| `contact_contact_groups` | 892,330 | 776,977 | 1,093,863 | 41.5% | 47.8M | group-filter membership scans |
| `opt_outs` | 68,531 | 9,276,655 | 101,975,749 | 8.3% | 80.4M | mostly indexed (contact_id idx = 96.9M scans), but 9.3M seq scans remain |
| `campaign_events` | 1,198 | 272 | 989 | 21.6% | — | small, ignorable |

`clicks`, `contacts`, `links`, `stage_sends` are all <0.2% seq — well-indexed for point lookups. The problem tables are the **junctions and small satellite tables that get full-scanned inside larger query plans** (`clickers`, `segment_contacts`, `stage_result_rows`, `contact_contact_groups`).

### Missing-index candidates (named to the query that suffers)

1. **`clicks (classification, scored_at)`** partial `WHERE scored_at IS NOT NULL` — propagate-clickers currently seq-scans all of `clicks` (§2 #1). **CRITICAL.**
2. **`clickers (org_id, contact_id, brand_id, source, offer_id)`** — the propagate `NOT EXISTS` anti-join has no composite to satisfy it; drives the 92.8M `clickers` seq scans. **CRITICAL.**
3. `segment_contacts` — 67.8% seq at 5.3M scans; the segment-eval membership branch needs a plan that uses `(segment_id)` reliably (present as pkey prefix but not being used). **HIGH.**

### Unused / underused indexes (write-cost for no read benefit)

On the hottest-write table (`contacts`) and others:

| Table | Index | Size | idx_scan | Verdict |
|-------|-------|-----:|---------:|---------|
| `contacts` | `contacts_org_created_eligible_idx` | **16 MB** | **0** | dead weight on a hot table |
| `contacts` | `contacts_org_eligible_idx` | **8.4 MB** | **0** | dead weight |
| `contacts` | `contacts_phone_number_trgm_idx` | **46 MB** | 10 | trigram search, barely used, huge |
| `contacts` | `contacts_org_id_created_at_idx` | 16 MB | 52 | near-unused |
| `contacts` | `contacts_org_carrier_eligible_idx` | 10 MB | 8 | near-unused (recent Telnyx) |
| `contacts` | `contacts_org_linetype_eligible_idx` | 8.5 MB | 8 | near-unused (recent Telnyx) |
| `contact_contact_groups` | `contact_contact_groups_group_contact_idx` | **35 MB** | 3 | huge, effectively unused |
| `stage_sends` | `stage_sends_link_id_idx` | **29 MB** | 34 | huge, effectively unused |
| `send_attempts` | `send_attempts_pkey` | 16 MB | **0** | pkey never used for lookups (insert-only table) |
| `creative_exposures` | `creative_exposures_pkey` | 15 MB | 3 | near-unused |
| `offer_exposures` | `offer_exposures_pkey` | 5 MB | 2 | near-unused |
| `links` | `links_stage_contact_send_token_unique` | **65 MB** | 2,130 | correctness constraint, but enormous |

`contacts` carries **231 MB of indexes on a 117 MB heap** — roughly **80+ MB is dead or near-dead** (`org_created_eligible` 16 MB @ 0, `org_eligible` 8.4 MB @ 0, plus several near-zero). Every `contacts` insert/update/backfill (e.g. the 23.6 s Telnyx carrier UPDATE touching all 752K rows) pays to maintain all of them.

- **Impact today:** **MEDIUM** (missing indexes cause the §2 #1 hotspot; dead indexes slow the Telnyx backfill and future writes).
- **Impact at 5M:** **HIGH** (index bloat and write amplification compound with every full-base send/backfill).

---

## §4 — Page Data-Fetch Audit  *(highest-priority section)*

Method: traced each page's `page.tsx` → API routes → query helpers. Legend: **AGG** = live COUNT/SUM/GROUP BY at load, **PAGED** = has LIMIT, **CACHED** = reads precomputed table/matview, **UNBOUNDED** = no LIMIT.

### The live-aggregate hotspots (v2 rollup targets), worst first

| # | Page / endpoint | Live aggregate | Table(s) scanned | Est. rows/load | Verdict |
|---|-----------------|----------------|------------------|---------------:|---------|
| 1 | **`/api/contacts/carrier-stats`** (contacts page) | `GROUP BY line_type, carrier_norm, messaging_status`, **no cap** | `contacts` | **full 752K — Parallel Seq Scan, 631 ms confirmed by EXPLAIN** | fires on every contacts load |
| 2 | **`/api/contacts/base-stats`** (contacts **and** dashboard) | 6 uncapped counts | `contacts` ×2, `opt_outs`, `opt_ins`, `clickers` | 752K + 69K + … | opt_outs distinct = 157 ms (idx-only, 15.6K heap fetches from vacuum lag); contacts counts uncapped |
| 3 | **Campaign detail → `/api/campaigns/[id]/stages`** (`maxDuration=30`) | per-stage audience batch + per-stage send counts + opt-out counts + Keitaro sums | `campaign_audience_pool` (393K), `stage_sends` (745K), `opt_outs`, `keitaro_stage_results` | one campaign's slice of each large table | every campaign-detail load; de-N+1'd but still touches 745K/393K tables |
| 4 | Campaign detail → `/stages/lane-counts` (`maxDuration=30`, only if lanes) | `campaignTierExpr` tier scan | `campaign_audience_pool` ⋈ `clicks` ⋈ `links` ⋈ `stage_sends` | multi-table, "seconds-long" (self-documented) | fires on load when behavioural lanes exist |
| 5 | **`/api/keitaro/reports`** (`/reports`) | 4 aggregates, **pagination is in-memory** (whole result computed per page/sort) | `keitaro_stage_results` (unpaginated fold), `stage_sends` grouped, `opt_out_attributions`, manual sales | all in-range rows | recomputed on every filter/sort/page change |
| 6 | **`/api/segments/[id]/audience`** (segment detail, default tab) | **two** live UNION audience evaluations (rows + count) | segment eval → can fan to `contacts` 752K via rules | up to full audience twice | every segment-detail load |
| 7 | `/api/creatives/list` (stage picker + list) | returns up to 14,517 rows | `creatives` (+cache join) | 3.3 s mean | PAGED at endpoint, but large pageSize pulls a lot |

### Unbounded / no-LIMIT fetches

- **`/api/keitaro/reports`** main fold over `keitaro_stage_results` has **no LIMIT** — bounded only by date range; pagination happens in JS after the full set is built. **HIGH** at scale.
- **`/api/campaigns/[id]/stages`** stage `SELECT` has no LIMIT (returns all non-archived stages). Fine in practice (few stages/campaign), technically unbounded. **LOW.**
- CSV exports stream but re-scan with growing OFFSET (see §6). **MEDIUM.**

### Well-mitigated (NOT concerns) — good patterns to keep

- **Campaigns list** — de-N+1'd: page rows PAGED, stage meta/counts bounded to the 20 visible campaigns via one grouped query.
- **Contacts list count** — deliberately **capped at 10,000** (`cap_sub` subquery) returning `countApprox` — the fix for the former ~670 ms exact count. Keep this pattern.
- **Segments list + header** — counts read from **`segment_stats`** (precomputed), not live.
- **Offer report** (`/offers/[id]/report`) — reads **matviews**, refreshed by cron. Correct rollup model — the template for v2.
- **Dashboard stats / daily-activity** — aggregate the smaller `campaign_stages`/`campaigns` tables, not per-send tables.
- **ClickReport + CampaignActivity** — wrapped in `<DeferUntilVisible>`; do not fire on first paint.

- **Impact today:** **HIGH** (carrier-stats 631 ms + base-stats + stages aggregates on the two most-used pages).
- **Impact at 5M:** **CRITICAL** (carrier-stats becomes a multi-second full-scan of 5M contacts on every contacts page; segment-audience and stage aggregates scale with pool/audience size). **These are the primary candidates for pre-computed rollup tables in v2.**

---

## §5 — Background Job Inventory

Nine registered crons (`vercel.json`). All set `maxDuration` explicitly. Two pinned `preferredRegion="fra1"` to co-locate with Supabase.

| Cron | Schedule | maxDur | Batch bound | Overlap guard | Writes admin-read tables |
|------|----------|-------:|-------------|---------------|--------------------------|
| `/api/cron/send-scheduled` | */5 | 300 | `maxStages=50`; per-provider tick budget | `FOR UPDATE SKIP LOCKED` (drain) + dedup unique idx (materialize); **no run-level lock** | `stage_sends`, `send_attempts`, `campaign_stages` (heavy) |
| `/api/keitaro/poll` | */5 | 60 | none (all rows in 3-day window) | **none** | `keitaro_stage_results`, `campaign_stages` |
| `/api/clicks/score-pending` | 3,18,33,48 | 60 (fra1) | `maxRows=2000` (cap 20K), keyset | **none** (bounded) | `clicks`; then **propagate-clickers** → `clickers` |
| `/api/opt-outs/poll` | 6,21,36,51 | 60 (fra1) | none (all inbox msgs, all creds), **1 txn/message** | **none** (per-msg dedup unique) | `opt_outs`, `contacts`, `opt_out_attributions`, `campaign_stages`, `texthub_inbound_events` |
| `/api/keitaro/poll-conversions` | 9,24,39,54 | 60 | none (7-day window); UPDATE chunked 500 | **none** | `stage_sends` |
| `/api/keitaro/poll-offer-reaches` | 12,27,42,57 | 60 | none (7-day window); UPDATE chunked 500 | **none** | `stage_sends` |
| `/api/cron/telegram-report` | 0 * * * * | 60 | read-only | 50 s internal guard | — |
| `/api/cron/refresh-offer-group-report` | 0 5,20 | 300 | 2× `REFRESH MATVIEW CONCURRENTLY` | none (twice-daily) | matviews |
| `/api/cron/lookup-worker` | */2 | 300 | `CLAIM_MAX=50`, `BUDGET_MS=250s` | **row-lease CAS + FOR UPDATE SKIP LOCKED** (best-designed) | `contacts`, `stage_sends`, `campaign_audience_pool` (small phone batches) |

### Jobs that write heavily to tables admin pages read (lock/contention suspects)

- **`send-scheduled`** is the dominant writer: materializes `stage_sends` in 2,000-row windows and updates status per 50-row drain batch, inserts `send_attempts` in bulk, updates `campaign_stages` cost/counters. Campaign-detail and reports pages read exactly these tables live (§4 #3, #5). During a large drain the pages compete with the writer for `stage_sends`.
- **`opt-outs/poll`** runs **one transaction per inbound message**, each touching 5 admin-read tables — slow at high STOP volume, and `campaign_stages` counter updates contend with dashboard/report reads.
- **Keitaro pollers** re-clobber the last 3–7 days of `keitaro_stage_results`/`stage_sends` every run; `/reports` reads those live.

### Jobs that break or need redesign at 5M / 60M+ event rows

1. **propagate-clickers** (`lib/links/propagate-clickers.ts`, via `score-pending`) — **full `clicks` seq-scan + 4-table join + anti-join, all-time, every 15 min.** Cost scales with total click history, not deltas. Already the #1 DB consumer at 277K clicks; at 22M+ it will not fit in a 60 s function. **Needs incremental/watermarked processing + the two indexes from §3.** **CRITICAL.**
2. **`enumerateStageRecipients`** (`lib/sends/recipients.ts:213`) — **loads the entire qualifying recipient set into a JS array with no LIMIT** (self-documented caveat). Only the DB *writes* are windowed (2,000). Reached by manual kickoff (300 s) and `send-scheduled` Phase A. At a 5M-contact audience this is a multi-GB in-memory allocation + one unbounded query in a serverless function → **OOM / timeout.** **CRITICAL.**
3. **Telnyx backfill** (`lib/telnyx/backfill.ts:95` → `enqueue.ts:73`) — full-base path (`sampleLimit=null`) loads **all distinct phones into a JS array** and passes them as a single `unnest(array)` bound parameter in one 60 s txn. Unbounded in heap and param size. **HIGH.**
4. **Keitaro `poll` UPSERT loop** — **one round-trip per aggregate** (`poll.ts:391-414`), unlike conversions/offer-reaches which batch to CHUNK=500. Grows with active-stage-days. **MEDIUM.**
5. **`refresh-offer-group-report`** — `REFRESH … CONCURRENTLY` re-scans full base tables (~50 s cold today, 27.6 s mean for the big matview); refresh duration grows with total send history against a fixed 300 s ceiling. **No try/catch/alert on failure** (also in project memory). **MEDIUM→HIGH.**
6. **`countSentSince(org, 86400)`** re-runs **every 50-row drain batch** (`drain.ts:286`), scanning a 24 h window of org-wide `stage_sends` repeatedly during a high-volume drain. **MEDIUM.**
7. **No run-level overlap lock** on any Keitaro poller or `opt-outs/poll` — they rely on idempotency/dedupe (correct), but a run exceeding its interval overlaps and doubles external-API + DB load. Only `lookup-worker` (lease) and structurally `send-scheduled` are guarded. **MEDIUM.**

### Well-designed for scale (keep)

- **`lookup-worker`** — proper single-runner **row-lease CAS** (`lib/telnyx/lease.ts`), `FOR UPDATE SKIP LOCKED`, budget + heartbeat, batched claims. The model for other jobs.
- **`send-scheduled` drain** — at-most-once claim via `FOR UPDATE SKIP LOCKED`; materialization idempotent via `stage_sends_active_contact_uniq`; resumable via `materialized_at`.
- **conversions / offer-reaches pollers** — batched UPDATE CHUNK=500, monotonic guards.

- **Impact today:** **HIGH** (propagate-clickers dominates DB time; drain contends with reads).
- **Impact at 5M:** **CRITICAL** (items 1–3 fail outright at scale).

---

## §6 — Connection & Infra Limits

### Pooler / connections

- App pool: `db/client.ts` → `postgres(url, { prepare:false, max:5 })`, `globalThis` singleton (non-prod only). **No `idle_timeout` / `connect_timeout` / `max_lifetime`** set. `max:5` per instance; aggregate across Vercel lambda instances is absorbed by the transaction pooler (:6543) — correct design.
- `max_connections = 90` on the instance. **At the moment of inspection: 14 total connections, 1 active, 0 idle-in-transaction, 0 waiting on locks** — no saturation now. (Recent connection errors are not retained in the DB; check Vercel/Supabase logs for history — not available read-only here.)
- **Only `scripts/*` create side pools** (`max:1`, diagnostic/CI). No `lib/` or request path bypasses the singleton. **LOW.**
- Long-running transactions holding a pooled connection: `snapshotAudience` (two `ON COMMIT DROP` temp tables, whole snapshot in one txn, route `maxDuration=60`) and `enqueueNormalized`. CSV import uses per-chunk autocommit (good). Bounded but load-bearing at scale.
- **Config drift (docs already flag):** `.env.example:30` / `PROJECT-STATE.md:177` show a sample `DATABASE_URL` on port **5432 / Session Pooler**, contradicting the mandated **6543 / Transaction Pooler**. Config/doc only, not code. **LOW.**

### Vercel function timeouts

- **No `export const runtime`** anywhere → all routes on default **nodejs** runtime (no edge).
- `maxDuration`: **300** on `send/kickoff`, `send/approve-send`, `cron/send-scheduled`, `cron/refresh-offer-group-report`, `cron/lookup-worker`; **60** on status, exports (clickers/contacts), spam, all pollers, all `telnyx/lookup/*`, drain, retry, telegram; **30** on `stages` + `lane-counts`; **default (~15 s)** on everything else including list endpoints.
- **`export-phones` route has NO `maxDuration`** (`app/api/campaigns/[campaignId]/stages/[stageId]/send/export-phones/route.ts`) — its siblings `export-clickers`/`export-contacts` were bumped to 60 for this reason; this one was missed. Streams an offset-paginated, content-deduped recipient query on the ~15 s default → **silently truncated CSV** at scale. **MEDIUM.**
- The three 300 s O(audience) routes (`kickoff`, `approve-send`, `send-scheduled`) mitigate via resumable windowing — but a single un-resumable step (the `enumerateStageRecipients` load, §5 #2) can still exceed 300 s at 5M. **HIGH.**

### Hardcoded small-data assumptions / in-memory whole-table loads

| Sev | Location | Pattern | Bounded? |
|-----|----------|---------|----------|
| **HIGH** | `lib/sends/recipients.ts:213` (`enumerateStageRecipients`) via `kickoff.ts:262` + `scheduled.ts:302` | entire stage recipient set → JS array, no LIMIT; only writes windowed | **No** |
| **HIGH** | `lib/telnyx/backfill.ts:95` → `enqueue.ts:73` | all distinct phones → JS array → single `unnest(array)` param, 60 s | No when `sampleLimit=null` |
| MEDIUM | `app/api/.../send/export-phones/route.ts` | streaming export, **no `maxDuration`**, offset pagination + per-chunk dedup recompute | truncates on timeout |
| MEDIUM | `lib/csv/stream-export.ts:72` (all CSV exports) | OFFSET pagination, O(n²) deep scans; documented sub-million only | memory ✓, time ✗ |
| MEDIUM | `lib/links/geoip.ts` + `geoip-cache.ts` | ~8 MB bytea blob fetched+parsed **once per cold-start instance** (NOT per click — parent premise corrected) via `/tmp` L1 + per-instance singleton | per-instance |
| LOW | `db/client.ts` | `max:5`, no `idle_timeout`/`max_lifetime` | design-bounded |

**geoip correction:** the click redirect (`app/r/[code]`) never touches geoip; scoring is keyset-batched in the cron with an in-memory maxmind `Reader`. The 1.7 s × 729 in `pg_stat_statements` is the ~8 MB blob fetch **on cold start**, not per click. Bounded per instance, but no cross-invocation reuse beyond `/tmp`.

- **Impact today:** **LOW–MEDIUM** (no saturation; export-phones truncation is the live bug).
- **Impact at 5M:** **HIGH** (recipient-load OOM and backfill array-param are the two code-level walls; export truncation worsens).

---

## One-Page Summary — Top 5 Issues Overall

| # | Issue | Where | Today | 5M | Why it's on this list |
|---|-------|-------|:-----:|:--:|-----------------------|
| **1** | **propagate-clickers full-scans all-time `clicks` every 15 min** (no `(classification,scored_at)` index, no composite anti-join index on `clickers`; re-derives 22.5K rows to insert ~15K) | `lib/links/propagate-clickers.ts`; cron `clicks/score-pending` | HIGH | **CRITICAL** | **30.3% of ALL database time** — the single biggest consumer. Confirmed Parallel Seq Scan. Cost scales with total history; won't fit a 60 s function at 22M+ clicks. Also drives the 92.8M `clickers` seq-scans. |
| **2** | **Unbounded append-only event tables, no partitioning/retention** (`stage_sends`, `links`, `send_attempts`, `creative_exposures`, `clicks`) | schema / §1 | LOW | **CRITICAL** | ~2 GB in 40 days; ~34–38 GB/yr each at 5M send volume. One full-base campaign = 5M rows × 4 tables ≈ 10–12 GB written at once. This is the core v2 architecture problem. |
| **3** | **`enumerateStageRecipients` loads the whole audience into memory** (no LIMIT); only DB writes are windowed | `lib/sends/recipients.ts:213`; kickoff + send-scheduled | MEDIUM | **CRITICAL** | Multi-GB JS array + one unbounded query in a 300 s serverless function → OOM/timeout at a 5M-contact audience. The send path's hard wall. |
| **4** | **Live full-table aggregates on the busiest pages** — contacts `carrier-stats` (631 ms full seq-scan, confirmed) + `base-stats` (6 uncapped counts); campaign-detail stage aggregates over `stage_sends`/`campaign_audience_pool`; segment-audience double-eval; `/reports` in-memory pagination | `/api/contacts/carrier-stats`, `/base-stats`, `/campaigns/[id]/stages`, `/segments/[id]/audience`, `/api/keitaro/reports` | HIGH | **CRITICAL** | Recomputed every page load with zero org selectivity (single org). Primary targets for pre-computed rollup tables in v2 (the offer-report matview is the model). |
| **5** | **`contacts` index bloat + Telnyx full-table backfills** — 231 MB indexes on 117 MB heap (~80 MB dead/near-dead); `UPDATE contacts SET carrier_norm` scans all 752K at 23.6 s mean | §3 index audit; `lib/telnyx/backfill.ts`, carrier UPDATE | MEDIUM | **HIGH** | Every contact write/backfill maintains dead indexes; the Telnyx full-base UPDATE (17 calls, 23.6 s each) and `unnest(array)` enqueue are unbounded write amplifiers that scale directly with contact count. |

**Honourable mentions (next tier):** matview refresh duration growth vs. fixed 300 s ceiling with no failure alert (§5 #5); no run-level overlap lock on the four pollers (§5 #7); `export-phones` missing `maxDuration` → truncated CSV (§6); `opt-outs/poll` one-txn-per-message at high STOP volume (§5); per-batch `countSentSince(86400)` re-scans during drain (§5 #6).

**Structural themes for v2 design (findings only, not fixes):**
1. Event tables need a lifecycle (partition by time and/or campaign; a retention/rollup story) — everything in §1/§2 traces back to append-only-forever.
2. Interactive pages need pre-computed rollups instead of live aggregates — the `segment_stats` / offer-report-matview pattern already works; the gap is contacts stats, per-stage send counts, and reports.
3. Batch jobs need to be incremental/watermarked (propagate-clickers, Keitaro re-clobber) and streaming instead of load-all-into-memory (recipients, backfill).
4. `org_id` gives no selectivity while there's one tenant — do not rely on it for scan reduction in v2 planning.

---

*Prepared read-only via Supabase transaction pooler (:6543) + static code trace. `pg_stat_statements` counters are cumulative since last reset; treat percentages as relative, not absolute-since-a-fixed-window. No changes were made to code, data, schema, indexes, or settings.*
