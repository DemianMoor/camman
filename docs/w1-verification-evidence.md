# W1 — Quick Wins: kill the #1 DB consumer + close live gaps

Smallest set of changes for the largest load reduction, from `V2-PHASE0-RECON.md`. No schema redesign / rollups / partitioning (those are W2–W4).

**⚠️ Do not merge until tomorrow morning (Warsaw), outside the send window.** Some DB objects were already applied to prod out-of-band (indexes + `cron_locks` table + `0103` migration record) so the currently-deployed propagate query is already faster; the app code takes effect on deploy.

## Tasks & verification

### 1b — propagate indexes ✅
- `clicks_classification_scored_at_idx` on `clicks(classification, scored_at) WHERE scored_at IS NOT NULL`
- `clickers_org_contact_brand_source_offer_idx` on `clickers(org_id, contact_id, brand_id, source, offer_id)`
- Applied `CONCURRENTLY` out-of-band (can't run in a migration txn); recorded in `db/w1-indexes.sql`.
- **EXPLAIN:** `clicks` Parallel Seq Scan → **Index Scan**; clickers anti-join → **Index Only Scan**. No seq scan.

### 1c — incremental watermark ✅
- High-water mark on `clicks.scored_at` in `cron_locks(job_name='propagate-clickers')`. Each run processes only `scored_at ∈ (watermark, now()-5min]`; 5-min safety lag defers concurrent/late scores (never skips). Advances only after the INSERT commits; first run = one final full pass; `NOT EXISTS` guard retained.
- Watermark surfaced in the `score-pending` cron response.
- **Correctness diff (read-only, prod):** `all − new(watermark=NULL)` = **0** and reverse = **0** (rewrite ≡ old all-time set, 15,287 tuples); midpoint-split windows → `all − (after ∪ before)` = **0**, extras = **0** (no gaps/no loss).
- **Baseline `pg_stat_statements`:** propagate INSERT = 1,729 calls, **8,004.5 ms mean**, 3.8 h total (before/after table at +24h).

### 3 — export-phones maxDuration ✅
`maxDuration = 60` (was on the ~15s default → truncated CSVs). Matches siblings.

### 4 — poller overlap guards ✅
`cron_locks` + `withCronLease()` — pooler-safe lease **row** (advisory locks unsafe through `:6543`), same pattern as `lib/telnyx/lease.ts`. Guards the **scheduled** path of `keitaro/poll`, `poll-conversions`, `poll-offer-reaches`, `opt-outs/poll`; manual runs bypass. Skips bump `cron_locks.skipped_count`.
- **Migration 0103 coherence:** `verify-migration-integrity` → **OK** (0103 green: SQL/snapshot/hash/prevId-chain; 104 records == 104 journal); `db:migrate` → no-op (stayed 104 rows / 1 cron_locks record).

### 5 — connection pool hygiene + doc fix ✅
`db/client.ts`: `idle_timeout=20`, `connect_timeout=10`, `max_lifetime=1800`. `PROJECT-STATE.md`: corrected stale `:5432/session pooler` → `:6543/transaction pooler` (`.env.example` was already correct).

### 6 — matview refresh failure alert ✅
`refresh-offer-group-report`: try/catch + per-view duration logging + Tier-1 Telegram alert (duration + error) on failure → 500.

## Checks
- `npx tsc --noEmit` clean · `eslint` clean on all changed files.

## Post-deploy runbook (agreed)
1. Export full `pg_stat_statements` top-30 → repo (frozen baseline for W1-after + W2), then `pg_stat_statements_reset`.
2. Confirm first watermarked propagate run completed + watermark advanced in `cron_locks`.
3. +24h: before/after table for the propagate INSERT, no new top-offenders, `cron_locks.skipped_count` health.
4. Only then: **Task 2** (drop dead indexes) — grep-verify each, write `db/rollback-w1-indexes.sql`, `DROP … CONCURRENTLY`.

_Note: `verify-migration-integrity` run from `main` will show a count mismatch until this merges (0103 applied ahead of merge). Understood and accepted — not a bug._

🤖 Generated with [Claude Code](https://claude.com/claude-code)
