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

### Why it is two requests

⚠️ **The split is measured, not preferred.** Both halves were timed on
production, five runs each:

| | median | worst |
| --- | ---: | ---: |
| per-group grid, `available_today` included | **1,812 ms** | 1,863 ms |
| cluster rollups + distinct footer | 6,311 ms | 9,369 ms |

The rollups need DISTINCT contacts across ~1.1M membership rows, and that
dedup is inherent — `count(DISTINCT)` cost ~8.2s, a per-contact `array_agg`
collapse 6.2–14.1s. Serving them together would put the whole screen behind the
slower half, so the grid loads first (inside the 2s bar) and the rollups fill in
beneath it.

⚠️ **The grid is fast because availability is decided ONCE PER CONTACT, then
fanned out to memberships.** Deciding it per membership row — the obvious shape
— costs median 2,659 ms / worst 2,690 ms, because there are 1,129,787
memberships over 973,731 contacts and the anti-joins then run on the larger
relation. Single runs of these shapes ranged 2.1s to 15.9s to a statement
timeout with no code change, so only repeated, interleaved spreads were used.

No migration: every index this needs already exists.

CSV export covers clusters, groups and the footer in one file.

## Where it lives

| | |
| --- | --- |
| Page | `app/(protected)/reports/group-lifecycle/page.tsx` → **Reports → Group × Lifecycle** |
| API | `GET /api/reports/group-lifecycle?part=table\|rollups&days=N` (`contacts.view`) |
| Route map | `reports/group-lifecycle`, `GET` (also token-readable) |
| Query | [lib/reporting/group-lifecycle.ts](../../lib/reporting/group-lifecycle.ts) |
| Cluster config | [lib/reporting/group-clusters.ts](../../lib/reporting/group-clusters.ts) |
| Client shapes | [lib/reporting/group-lifecycle-types.ts](../../lib/reporting/group-lifecycle-types.ts) — split out only because the query module is `server-only` and the table needs the status list at runtime |
| Table | [components/reports/group-lifecycle-table.tsx](../../components/reports/group-lifecycle-table.tsx) |
| Bars | [scripts/test-group-lifecycle.ts](../../scripts/test-group-lifecycle.ts) (13) |
| Measurement | [scripts/measure-group-lifecycle.ts](../../scripts/measure-group-lifecycle.ts), read-only |

It began as a section inside Audience Stats and was moved to its own tab on
2026-09-28 (owner). Nothing about the numbers changed — the same component, the
same two requests — so the move is a relocation, not a rewrite.
