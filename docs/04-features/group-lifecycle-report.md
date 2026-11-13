# Feature — Group × Lifecycle report

_Last updated: 2026-11-13 (hourly refresh on its own cron; single-pass compute in one transaction; "Refresh now" is a POST under the cron's lease); 2026-10-23 (Hot and Warm separate columns; order New · Hot · Warm · Cold · Freeze · Suppressed · Total)_

A read-only report for **sizing a daily campaign**: how many contacts each
contact group can still be messaged today, split by lifecycle status. It is its own tab — **Reports → Group × Lifecycle**
(`/reports/group-lifecycle`) — and the same component renders one row on each
**contact group's detail page**.
[lib/reporting/group-lifecycle.ts](../../lib/reporting/group-lifecycle.ts),
behind `GET /api/reports/group-lifecycle` (**`contacts.stats`**, not `contacts.view`: the report shows audience SIZE and never a contact row, and those are separate grants — gated on `contacts.view` it returned 403 to the OPERATOR role, which is the role that sizes the daily sends).

**Columns, in order: New · Hot · Warm · Cold · Freeze · Suppressed · Total**
(owner, 2026-10-23) — one column per status, in the table, the contact-group
page and the CSV export alike.

**Hot and Warm are separate columns** (2026-10-23). From 2026-09-28 they shared
one "Hot/Warm" column; the stored rows were always **per status**, so the split
is presentation only and no number changed. Bar L3 pins that no column holds
both.

⚠️ **Summing statuses is safe because they are disjoint.** A contact has exactly
one `lifecycle_status`, so the Total column double-counts nobody — including on
the cluster and distinct-total rows, which are themselves DISTINCT unions. That
would not hold for any grouping whose members could overlap, which is why bar L4
asserts the disjointness rather than assuming it.

⚠️ **The visible columns must PARTITION the status set** — every status in
exactly one column, none twice — or the Total column silently stops equalling
the sum of what is on screen. `GROUP_LIFECYCLE_COLUMNS` in
[lib/reporting/group-lifecycle-types.ts](../../lib/reporting/group-lifecycle-types.ts)
is the single definition, used by the table and the CSV alike, and bars L1/L2
pin the partition and the total.

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
here comes from `contact_engagement`, which the engagement job refreshes every
15 minutes (and this table itself is recomputed hourly), while
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
(median 10,957 ms)** across two requests. Since 2026-11-13 an **hourly** cron —
[`/api/cron/refresh-group-lifecycle`](../../app/api/cron/refresh-group-lifecycle/route.ts)
at **:13**, three minutes after the :10 engagement tick — computes the whole
thing and writes ~126 rows to `group_lifecycle_rollup`; the page reads those in
**~50 ms**. (From 0193 until 2026-11-13 the 15-minute engagement job recomputed
it after every recount; the owner moved it to hourly.)

| | median |
| --- | ---: |
| before — computing on read, both requests | **10,957 ms** |
| after — reading the stored table | **50 ms** |
| one refresh (2026-09-28 measurement; ~30–43 s per half by 2026-11-13) | 7,077 ms |

### One pass, one transaction (2026-11-13)

Until 2026-11-13 a refresh ran **two** statements in parallel — the group grid
and the cluster/distinct rows — that each re-derived the same per-contact flags
(in use / blocked / opted out) over ~1M contacts, ~30–43 s each on production,
each with its own `now()` and in-use set. It then ran `DELETE` and `INSERT` as
two separate autocommitted statements, so a reader between them saw an **empty
table**, and two overlapping writers (the cron and the button, seen 2026-11-13
10:10) could collide on the primary key.

Now [`refreshGroupLifecycleRollup`](../../lib/reporting/group-lifecycle-store.ts)
takes the caller's transaction and
[`computeGroupLifecycle`](../../lib/reporting/group-lifecycle.ts) does, inside it:

1. `CREATE TEMP TABLE gl_flags ON COMMIT DROP` — one row per sendable contact
   with its status and `avail` flag, computed **once**;
2. `ANALYZE gl_flags` — real row counts for the planner;
3. one statement deriving the group grid, the cluster rows and the distinct
   total from it;
4. `DELETE` + `INSERT` of the org's rows — **in the same transaction**.

Readers see the old rows or the new rows, never neither. Every statement gets
`SET LOCAL statement_timeout` = what is left of the caller's budget (never a
session `SET` — the pooler leaks those), so a slow run ends in a 57014 the route
reports, not a Vercel 504. `computed_at` is the INSERT's `statement_timestamp()`
— when the numbers landed.

⭐ **The stored rows are identical to the two-pass ones.**
[scripts/test-group-lifecycle.ts](../../scripts/test-group-lifecycle.ts) PART M
diffs the frozen two-pass compute
([scripts/_legacy-group-lifecycle.ts](../../scripts/_legacy-group-lifecycle.ts))
against the single pass — and against the rows the refresh actually stores —
row by row, inside ONE `REPEATABLE READ` snapshot (`now()` and the in-use set
cannot move between them), for the fixture org and every preview org with
memberships. Bar K7 pins that a reader on another connection sees the old rows
while a refresh is uncommitted.

### "Refresh now"

`POST /api/reports/group-lifecycle/refresh` (`contacts.stats`, the same grant
the button needed before). It takes the **same per-org lease as the hourly
cron** (`cron_locks` row `group-lifecycle-rollup:<org_id>`), so a click and the
cron never compute at once:

| Response | When | The page |
| --- | --- | --- |
| `200 { outcome: "recomputed", …table }` | lease free, last run ≥ 2 min old | shows the new numbers + "just recomputed" |
| `200 { outcome: "reused", …table }` | a run finished < 2 min ago | shows that run; nothing recomputed |
| `202 { outcome: "in_progress", computed_at }` | the cron or another click holds the lease | starts nothing; polls the cheap `GET` every 4 s until `computed_at` moves past the returned value (ceiling 5 min), then shows that run |
| `504 { code: "statement_timeout" }` / `500` | the compute hit its 100 s budget / failed | toast + inline error; stored rows untouched (one transaction) |

Route `maxDuration = 120`; the compute's statement budget is 100 s and the
lease 3 min (a killed function's SQL runs until its timeout). The client keeps
the button's in-flight state separate from the page load, disables the button
while it runs, shows "Recomputing… N s" / "A refresh is already running —
waiting for it… N s" next to it, and drops a response whose rest window
(`days`) changed meanwhile. A bare platform 504 (no JSON body) is spelled out
rather than shown as "Unexpected response from server".

For a rest window other than 3 days the button simply re-reads the `GET`,
which computes that window live and never stores it.

⚠️ **`GET` is read-only.** The old `?refresh=1` write path is gone: a `GET` that
writes is one any prefetch, crawler or API token can trigger.

⚠️ **API tokens can read (`GET`) but not `POST` the refresh — owner decision
pending.** One commented line in `OPERATOR_ROUTE_MAP` flips it.

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

The header **always shows when**: "as of Nov 13, 2026 11:32 AM ET · 40 s ago",
plus "— just recomputed", "— a recompute had just finished, so it was reused" or
"— from the run that was already in progress" after the button, "— computed for
N days, not stored" for another window, and "not computed yet" before the job
has ever run. A stored number and a live one are otherwise indistinguishable,
and the difference is up to an hour of sends.

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
| API | `GET /api/reports/group-lifecycle?days=N` (`contacts.stats`) — stored for N = 3, computed live (never stored) for any other N; read-only |
| Refresh | `POST /api/reports/group-lifecycle/refresh` (`contacts.stats`) — [route](../../app/api/reports/group-lifecycle/refresh/route.ts) |
| Cron | [`/api/cron/refresh-group-lifecycle`](../../app/api/cron/refresh-group-lifecycle/route.ts), `13 * * * *`; heartbeat `contact-engagement-group-rollup` (2.5 h) |
| Stored table | `group_lifecycle_rollup` (migration 0193), written hourly by the cron and on demand by the button |
| Store layer | [lib/reporting/group-lifecycle-store.ts](../../lib/reporting/group-lifecycle-store.ts) |
| Route map | `reports/group-lifecycle`, `GET` (also token-readable); `reports/group-lifecycle/refresh`, `POST` (not token-usable — owner decision pending) |
| Query | [lib/reporting/group-lifecycle.ts](../../lib/reporting/group-lifecycle.ts) |
| Cluster config | [lib/reporting/group-clusters.ts](../../lib/reporting/group-clusters.ts) |
| Client shapes | [lib/reporting/group-lifecycle-types.ts](../../lib/reporting/group-lifecycle-types.ts) — split out only because the query module is `server-only` and the table needs the status list at runtime |
| Table | [components/reports/group-lifecycle-table.tsx](../../components/reports/group-lifecycle-table.tsx) |
| Bars | [scripts/test-group-lifecycle.ts](../../scripts/test-group-lifecycle.ts) (G/H/J/K/L + M identity, O lease, N wiring); frozen reference [scripts/_legacy-group-lifecycle.ts](../../scripts/_legacy-group-lifecycle.ts) |
| Measurement | [scripts/measure-group-lifecycle.ts](../../scripts/measure-group-lifecycle.ts), read-only |

It began as a section inside Audience Stats, moved to its own tab on
2026-09-28, and was switched to a stored table later the same day when the page
proved too slow to compute on read. The numbers have not changed at any point —
bar K1 asserts the stored table reproduces the computed one cell for cell.
