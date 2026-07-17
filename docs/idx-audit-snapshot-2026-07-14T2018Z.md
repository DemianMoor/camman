# Index audit snapshot — 2026-07-14 20:18:06 UTC

Baseline `idx_scan` for the W1 **Task 2** (dead-index drop) candidates, captured under the **live carrier-v2 workload**. We deliberately **did not** run `pg_stat_reset()` — it also zeroes the dead-tuple counters autovacuum relies on, and `contacts` currently holds **101,790 dead tuples** from the 193K scoped-lookup backfill. Instead we snapshot now and compute the **+12h diff** for the same rigor with no side effects.

## Method
- Cumulative `idx_scan` at the timestamp below. At **~2026-07-15 08:18 UTC (+12h)** re-read the same indexes; `diff = new_idx_scan − baseline`.
- **Drop rule (approved):** `diff == 0` over the 12h window ⇒ dead under the live workload ⇒ drop (with `db/rollback-w1-indexes.sql`). Any use ⇒ keep.
- `send_attempts_pkey` is a PRIMARY KEY — listed for reference only, **never dropped**.

## Baseline (snapshot @ 2026-07-14 20:18:06 UTC)

| Table | Index | Size | `idx_scan` (baseline) | Drop candidate? |
|-------|-------|-----:|----------------------:|-----------------|
| `contacts` | `contacts_org_created_eligible_idx` | 16 MB | **0** | yes — drop if diff 0 |
| `contacts` | `contacts_org_eligible_idx` | 8.3 MB | **0** | yes — drop if diff 0 |
| `contact_contact_groups` | `contact_contact_groups_group_contact_idx` | 35 MB | **4** | decide by diff |
| `contacts` | `contacts_org_carrier_eligible_idx` | 11 MB | **8** | decide by diff |
| `contacts` | `contacts_org_linetype_eligible_idx` | 11 MB | **8** | decide by diff |
| `contacts` | `contacts_phone_number_trgm_idx` | 47 MB | 10 | keep (phone search) — tracked |
| `stage_sends` | `stage_sends_link_id_idx` | 31 MB | 38 | keep — tracked |
| `send_attempts` | `send_attempts_pkey` | 17 MB | 0 | **PKEY — never drop** |

## Context
- `contacts`: `n_live_tup = 752,707`, `n_dead_tup = 101,790` (backfill churn; autovacuum will reclaim — do not reset stats).
- The carrier/linetype eligible indexes sat at `idx_scan = 8` in the W1 baseline (~24h earlier) and are **still 8** here → carrier v2's `sync-contacts` UPDATE (joins `phone_lookups → contacts` by `phone_number`) does **not** use them. The +12h diff will confirm whether any audience/eligibility query does.
- `contact_contact_groups_group_contact_idx` ticked 3 → 4 during this session, so it is *occasionally* used; the 12h diff decides.

## Diff result (measured ~2026-07-15 14:40 UTC, ~18h — past +12h)
| Index | baseline | now | diff | decision |
|-------|---------:|----:|-----:|----------|
| `contacts_org_eligible_idx` | 0 | 0 | **0** | **DROP** (migration 0113) |
| `contacts_org_created_eligible_idx` | 0 | 0 | **0** | **DROP** (migration 0113) |
| `contact_contact_groups_group_contact_idx` | 4 | 6 | **+2** | **KEEP** (in use — any-use rule) |
| `contacts_org_carrier_eligible_idx` | 8 | 8 | **0** | **KEEP** (new carrier-v2 partial — re-audit W2 Task 1) |
| `contacts_org_linetype_eligible_idx` | 8 | 8 | **0** | **KEEP** (new carrier-v2 partial — re-audit W2 Task 1) |

**Decision (final):** drop only the two `contacts` eligible indexes (`org_eligible`, `org_created_eligible`) via `db/migrations/0113_drop_dead_indexes.sql` (numbered 0113 — 0111/0112 reserved for the provider-credentials cutover). **Keep** `group_contact_idx` — it ticked `4 → 6` during the window, so the "any use = keep" rule applies. **Keep** the carrier/linetype pair (`0 diff`, but brand-new carrier-v2 partials; an 18h window on a day-old feature isn't representative — re-audit after 2+ weeks of real campaign-creation activity, folded into W2 Task 1). Rollback defs (all five): `db/rollback-w1-indexes.sql`. Applied to prod out-of-band via `DROP INDEX CONCURRENTLY` in the quiet window; verify-migration-integrity green at 112 rows after apply.
