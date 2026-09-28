# Feature — Group × Lifecycle report

_Last updated: 2026-09-28_

A read-only report for **sizing a daily campaign**: how many contacts each
contact group can still be messaged today, split by lifecycle status. It is its own tab — **Reports → Group × Lifecycle**
(`/reports/group-lifecycle`) — and the same component renders one row on each
**contact group's detail page**.
[lib/reporting/group-lifecycle.ts](../../lib/reporting/group-lifecycle.ts),
behind `GET /api/reports/group-lifecycle` (`contacts.view`).

Every cell is **available today / sendable**:

- **Sendable** — active, eligible (`messaging_status = 'eligible'`), not opted
  out.
- **Available today** — sendable, minus contacts already in an **active**
  campaign's pool, minus **Freeze** contacts still inside their own cadence,
  minus anyone messaged in the last **N days** (N defaults to 3 and is editable
  in the table header).

Status comes from `contacts.lifecycle_status`, the indexed projection.
`contact_engagement` is still read, but only for the two facts the projection
does not carry — the freeze cadence and `last_sent_at`.

⚠️ **This is a sizing estimate, not the send-time decision.** The freeze fact
here comes from a rollup the engagement job refreshes every 15 minutes, while
the send path re-checks freeze against `stage_sends` live (§3f). A send can
therefore drop contacts this table counted. Sizing tolerates that; a guarantee
would not, and the page says so.

### Clusters are DISTINCT; group rows are not

Cluster rollups are configured in
[lib/reporting/group-clusters.ts](../../lib/reporting/group-clusters.ts) — data
the SQL joins against, so adding a group to a cluster is a one-line edit with
no query change and no migration. The mapping keys on
`contact_groups.contact_group_id` (the operator-facing **code**), never the
serial id (which differs between databases) or the display name (which is
editable).

⚠️ **A cluster row is the DISTINCT union of its groups, not the sum of them.**
Someone in both Weight Loss and Weight Loss Y is one person to send to. The
per-group rows deliberately count a contact **in each group it belongs to**,
because "how big is this group" is a different question — so the group rows do
not sum to the distinct total, and a footer row states that total explicitly.
Measured on production: the group rows sum to **765,566** against **667,141**
distinct, a **98,425** overcount. Bars G6/H1–H3 pin both halves; either one
alone is satisfied by a wrong implementation.

A group in no cluster is not hidden — it renders unclustered, so a new group
appears the day it is created.

### It is read from a stored table (migration 0193)

⚠️ **The page does not compute any of this.** It used to, and waited **8.4–25.9 s
(median 10,957 ms)** across two requests. The engagement job already runs every
15 minutes over the same tables, so it computes the whole thing there and writes
~126 rows to `group_lifecycle_rollup`; the page reads those in **~50 ms**.

| | median |
| --- | ---: |
| before — computing on read, both requests | **10,957 ms** |
| after — reading the stored table | **50 ms** |
| one refresh (what the job does every 15 min) | 7,077 ms |

**Clusters and the distinct total are stored too**, not derived on read. Both
are DISTINCT unions across groups and cannot be recovered by summing the group
rows — which is the entire reason they are shown.

⚠️ **The refresh DELETEs the org's rows then INSERTs them**, rather than
upserting. An upsert cannot remove a row that should no longer exist — an
archived contact group, or a (group, status) pair that has emptied — and those
would sit in the table reported as real. Bar K5 pins it by archiving a group
and asserting its rows are gone.

⚠️ **Only N = 3 is stored, and each row carries the `recent_days` it answers
for.** Any other N is computed on demand and never written: storing an N = 7
result would leave the next page load showing a number for a question nobody
asked, under a timestamp that looked fresh. The page therefore recomputes when
the operator changes N, and says so while it does.

The header shows **"as of HH:MM"** for a stored figure, **"computed just now"**
after a refresh, and **"not computed yet"** before the job has ever run — a
stored number and a live one are otherwise indistinguishable, and the
difference is up to 15 minutes of sends.

### Why it is stored rather than tuned

The cost is the availability computation over `contact_engagement` plus the
rollups' DISTINCT across ~1.1M membership rows. Attribution between those two
**moved by 5x between measurement runs on the live database**:

| | run 1 | run 2 |
| --- | ---: | ---: |
| base counts alone | 2,309 ms | 1,950 ms |
| cost of the engagement join | 13,720 ms | 2,532 ms |
| cost of the in-use join | ~0 (−374 ms) | 518 ms |
| full table | 16,078 ms | 4,573 ms |

Rewriting the engagement predicate's `OR` as an indexable `UNION` (the §10e
pattern) measured **worse** on median — 8,974 ms against 4,573 ms — with ranges
that overlapped everything. A query whose cost cannot be attributed reliably
between two runs is one to move off the read path, not one to keep tuning.

The one stable finding across both runs: **the in-use join is not the problem**.
It is within noise of free.

## Where it lives

| | |
| --- | --- |
| Page | `app/(protected)/reports/group-lifecycle/page.tsx` → **Reports → Group × Lifecycle** |
| API | `GET /api/reports/group-lifecycle?days=N&refresh=1` (`contacts.view`) — stored by default; `refresh=1` or any N ≠ 3 recomputes |
| Stored table | `group_lifecycle_rollup` (migration 0193), written by the engagement job every 15 min |
| Store layer | [lib/reporting/group-lifecycle-store.ts](../../lib/reporting/group-lifecycle-store.ts) |
| Route map | `reports/group-lifecycle`, `GET` (also token-readable) |
| Query | [lib/reporting/group-lifecycle.ts](../../lib/reporting/group-lifecycle.ts) |
| Cluster config | [lib/reporting/group-clusters.ts](../../lib/reporting/group-clusters.ts) |
| Client shapes | [lib/reporting/group-lifecycle-types.ts](../../lib/reporting/group-lifecycle-types.ts) — split out only because the query module is `server-only` and the table needs the status list at runtime |
| Table | [components/reports/group-lifecycle-table.tsx](../../components/reports/group-lifecycle-table.tsx) |
| Bars | [scripts/test-group-lifecycle.ts](../../scripts/test-group-lifecycle.ts) (13) |
| Measurement | [scripts/measure-group-lifecycle.ts](../../scripts/measure-group-lifecycle.ts), read-only |

It began as a section inside Audience Stats, moved to its own tab on
2026-09-28, and was switched to a stored table later the same day when the page
proved too slow to compute on read. The numbers have not changed at any point —
bar K1 asserts the stored table reproduces the computed one cell for cell.
