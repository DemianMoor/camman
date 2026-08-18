# W2 — Rollup Layer

**Status:** In progress (feature branch `autopilot/869e462wm`)
**Freshness contract:** stats may lag up to 60 seconds behind reality; each rollup-backed UI element shows an "as of" timestamp.
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

**carrier_breakdown:** computed by the 1-min cron via `refreshContactOrgStats()`.
- Uses a single `contact_raw` CTE to scan `contacts` once, then aggregates into separate dimension CTEs.
- Runs as an UPSERT — safe to call concurrently.

### Cron

`/api/cron/refresh-contact-stats` runs every minute (`* * * * *`).
- Fetches all org IDs and calls `refreshContactOrgStats()` per org.
- Also serves as the initial backfill after migration 0145 is applied.

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
- `app/api/cron/refresh-contact-stats/route.ts` — 1-min cron
- `app/api/segments/[id]/audience/route.ts` — single evaluation (Task 4)
- `vercel.json` — 1-min cron schedule
- `scripts/test-contact-stats-rollup.ts` — verification script

## Verification

Side-by-side check: run `npx tsx scripts/test-contact-stats-rollup.ts` after applying the migration and letting the cron run once. Confirms rollup values match live aggregates within the 60-second window.
