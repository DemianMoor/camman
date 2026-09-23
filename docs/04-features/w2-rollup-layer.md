# W2 — Rollup Layer

**Status:** In progress (feature branch `autopilot/869e462wm`)
**Freshness contract:** stats may lag up to 60 seconds behind reality; each rollup-backed response carries a `stats_as_of` timestamp. **The contract is unchanged since 2026-09-23 - only who pays for it moved** (see "Update mechanism" below): a reader never sees numbers older than 60 s, but that recompute now happens on the read that needs it instead of 1,436 times a day for nobody.
**Feature flag:** set `ROLLUP_CONTACT_STATS=0` in Vercel env vars to instantly revert any converted page to the live-aggregate path.

## Why

The contacts page and dashboard were re-computing expensive aggregates over 750K+ rows on every load. The core 5M-readiness property: page speed must be independent of data size.

Targets identified in V2-PHASE0-RECON.md §4:
1. `/api/contacts/carrier-stats` — 631 ms full seq-scan, fires on every contacts-page load
2. `/api/contacts/base-stats` — 6 uncapped COUNT(*) over contacts×2, opt_outs, opt_ins, clickers
3. Campaign detail stage aggregates — live GROUP BY over stage_sends/campaign_audience_pool
4. Segment audience — two full audience evaluations per page load
5. Creatives list — 14,517-row unbounded return to the stage picker

## Task 1 — contact_org_stats rollup (migration 0145)

### Table

`contact_org_stats` — one row per org:
- Scalar counts (maintained by writers in real-time via atomic `ON CONFLICT DO UPDATE` increments):
  `total_count`, `archived_count`, `opt_out_count`, `opt_out_by_reason` (JSONB), `opt_in_count`, `clicker_count`
- `carrier_breakdown` JSONB (refreshed by the 1-min cron):
  `{total, by_line_type, by_carrier_norm, by_messaging_status}`
- `updated_at` — written on every update; UI shows "as of X"

### Update mechanism

**Scalar counts:** incremented by writers via `bumpContactOrgStats()` in `lib/contact-stats.ts`.
- `contacts/upload` bumps `total_count` by the number of newly-inserted contacts.
- `opt-outs/upload` bumps `opt_out_count` + per-reason bucket by inserted count.
- (The 1-min cron also does a full recompute as a safety net.)

**carrier_breakdown + full recompute:** `refreshContactOrgStats()`, triggered **on read**.
- Uses a single `contact_raw` CTE to scan `contacts` once, then aggregates into separate dimension CTEs.
- Runs as an UPSERT — safe to call concurrently.

### Refresh cadence — on read, past a 60-second TTL (changed 2026-09-23)

`ensureContactOrgStatsFresh(db, orgId)` in [lib/contact-stats.ts](../../lib/contact-stats.ts) recomputes only when the last **successful** full recompute is older than `CONTACT_STATS_TTL_MS` (60 s). Both stats endpoints call it before reading.

- **TTL basis is `cron_locks.watermark`, not `contact_org_stats.updated_at`** — `bumpContactOrgStats()` also stamps `updated_at`, and a writer's increment is not a full recompute; using it would skip the `carrier_breakdown` rebuild this exists for.
- **Concurrency**: the contacts page fires both endpoints at once. `withKeyedLease` (key `contact-stats:<org_id>`, 30 s TTL) collapses that into ONE recompute; the loser reads the row as it stands.
- **The stamp is written only after the recompute succeeds**, so a failed refresh cannot buy itself another minute of silence.
- **A failed refresh degrades to the stale row, never to a 500** — the response still carries `stats_as_of`.

⚠️ **Why it changed.** `/api/cron/refresh-contact-stats` ran every minute (`* * * * *`) and was **deleted**. Measured on prod 2026-09-23: **1,436 runs/day** (verified 1.00/min over a 6-minute sample) at **1,441 ms and 708 blocks each — 20.18 h of database time, 17.9% of ALL time the database spent on anything, and ~272 GB read**. Against that, `contact_org_stats` was **scanned 155 times and updated 50,374 times since 2026-05-07** (`pg_stat_user_tables`): about **325 recomputes per read**, for the only two readers there are. The recompute now follows the reads (~1–2/day), and the reader pays ~1.4 s when it fires — on a background fetch that neither page blocks on.

### Backfill

None needed: the first read after deploy recomputes the row. Migration 0145's initial population is likewise just the first read.

### API changes

`/api/contacts/carrier-stats` and `/api/contacts/base-stats` read from `contact_org_stats` when the flag is on, falling through to the live aggregate if the rollup row doesn't exist yet (first-load before cron runs).

### Backfill

Run the cron endpoint manually after applying migration 0145:
```
curl -X POST https://camman.vercel.app/api/cron/refresh-contact-stats \
  -H "Authorization: Bearer $CRON_SECRET"
```

## Task 4 — Segment audience single evaluation

`/api/segments/[id]/audience` previously evaluated the audience clause twice: once to fetch the page of rows (with LIMIT/OFFSET) and once to COUNT the total. Now uses a single CTE evaluation with `count(*) OVER ()` window functions to produce both the page and the counts in one pass.

## Files changed

- `db/migrations/0145_contact_org_stats.sql` — migration
- `db/migrations/meta/0145_snapshot.json` — snapshot
- `db/schema.ts` — `contact_org_stats` table
- `lib/contact-stats.ts` — rollup read/write/refresh helpers
- `app/api/contacts/carrier-stats/route.ts` — reads rollup
- `app/api/contacts/base-stats/route.ts` — reads rollup
- `app/api/contacts/upload/route.ts` — real-time writer increment
- `app/api/opt-outs/upload/route.ts` — real-time writer increment
- `app/api/cron/refresh-contact-stats/route.ts` — the 1-min cron, **deleted 2026-09-23**
- `app/api/segments/[id]/audience/route.ts` — single evaluation (Task 4)
- `vercel.json` — the 1-min cron schedule, **removed 2026-09-23**
- `scripts/test-contact-stats-rollup.ts` — verification script

## Verification

Side-by-side check: run `npx tsx scripts/test-contact-stats-rollup.ts` after applying the migration and after one read has populated the row. Confirms rollup values match live aggregates within the 60-second window.

Cadence/lease behaviour: `npx tsx --conditions=react-server scripts/test-contact-stats-ttl.ts` against the **preview** DB (6 bars: first read recomputes, a read inside the TTL does not, an expired watermark recomputes, a held lease collapses a concurrent reader, a failed recompute does not advance the watermark, zero residue).
