# Audience Stats Report

_Last updated: 2026-09-14_

A read-only report answering "for this contact group, which offers work?" —
the inverse of the [Offer Group Performance Report](offer-group-report.md),
over the same precomputed data. Pick a contact group and get:
- one row per offer ever sent to it, archived offers included;
- a pinned org-wide benchmark on top;
- a pinned **This group · all offers** total at the bottom.

ClickUp [869eydqn0](https://app.clickup.com/t/869eydqn0). Design:
[specs/2026-09-14-audience-report-design.md](../superpowers/specs/2026-09-14-audience-report-design.md).

Like the offer report it is a **historical decision aid**. Numbers are lifetime,
refreshed twice a day, and never drive campaign configuration.

## Entry point

`/reports/audience` is the **Audience Stats** tab under Reports
([app/(protected)/reports/audience/page.tsx](../../app/(protected)/reports/audience/page.tsx)
→ [components/reports/audience-report.tsx](../../components/reports/audience-report.tsx)).
It also appears as the last row of the sidebar's Reports group.
- **Access:** requires `campaigns.view` (viewer and up), like every Reports tab.
- **Label:** "Audience Stats", not "Audience", because the sidebar already has
  a nav *group* with that name.
- **URL state:** the selected group lives in `?group=<id>`. `page.tsx` reads
  it server-side (Next 16 async `searchParams`, so no `useSearchParams` /
  Suspense boundary). Picking a group rewrites it with
  `window.history.replaceState`, without navigating.

## Rows and metrics

- **Offer rows** are the `offer_group_report_mv` cells for `(org, group)`. Every
  metric equals that group's row on the offer report for the same offer; see
  [offer-group-report.md → Metric definitions](offer-group-report.md#metric-definitions-locked).
  They are per recipient and tracked campaigns only.
- **Archived offers are included by construction.** Neither the matview nor
  the read helper filters on `offers.status`, and an archived offer's row
  carries an "Archived" badge. Do not add a status filter anywhere in this read
  path; showing archived offers is a stated requirement. On 2026-09-14, 10
  archived offers (16 cells) and 4 archived groups had data.
- **The group picker** lists every group that has report data: active first,
  archived ones suffixed "(archived)".

| Totals-row metric | Definition |
|---|---|
| Sends, Revenue, Sales, Cost, Sent 7d/30d/90d | `SUM` of the group's offer cells. Additive: each `stage_sends` row belongs to exactly one stage → campaign → offer, and the cell join places it at most once per group |
| Clicks (EPC denominator) | `COUNT(DISTINCT counted_clickers.contact_id)` at **group** grain, with the cells' scope (tracked campaigns that targeted the group, recipient in the group) |
| Opt-outs | `COUNT(DISTINCT opt_out_id)` at **group** grain, same scope; recipient read from `opt_outs.contact_id` (see Data layer) |
| RPM / Net RPM / EPC / Net profit / Opt-out % | Derived from the row's own totals, never averaged across offers |
| Fresh pool | "—". Fresh pool is a per-offer quantity (sendable group members never sent *that* offer) |

**The totals row's clicks and opt-outs are lower than the rows added up, by
design.**
- **Clicks:** a contact who clicked two offers is one clicker in the group.
  Summing the cells overcounted by 25–50% on the large groups (2026-09-14:
  Memory 32,719 summed vs 23,815 distinct, +37.4%; Blood Sugar +49.8%).
- **Opt-outs:** deduplicated too, because `opt_out_attributions` is unique on
  `(opt_out_id, stage_id)`, so one opt-out *may* be credited to several stages.
  None were on 2026-09-14 (0 of 124,717), but that is data, not a guarantee.

**The org benchmark** is the same row as on the offer report
(`offer_report_org_summary_mv`, read through `readOrgBenchmark()`). It is
campaign-grain and covers tracked + manual campaigns. A contact in several
groups counts in each group's report, so groups never foot to it.

**Break-even** (the colour threshold for Net RPM) is this group's own
`cost / sends × 1000`, taken from the totals row.

## Data layer — migration 0180

`audience_report_group_totals_mv` (materialized, UNIQUE `(org_id, group_id)`) —
[db/migrations/0180_audience_report_group_totals.sql](../../db/migrations/0180_audience_report_group_totals.sql).
It is built from three CTEs:
- `sums` over `offer_group_report_mv`, for the additive columns;
- `group_clicks` and `group_optouts`, which recompute the non-additive columns
  at group grain with exactly the cells' `offer_report_tracked_campaigns` /
  `= ANY(camp.gids)` / org scope. This guarantees
  `max(cell) ≤ total ≤ sum(cells)` per group.

Supporting decisions:
- **Opt-out recipient comes from `opt_outs.contact_id`, not `stage_sends.contact_id`.**
  The cells' `cell_optouts` reaches the recipient through ~125K primary-key
  lookups into `stage_sends` (36.8s). `opt_outs` carries the same contact
  (0.57s). `oa.stage_send_id IS NOT NULL` keeps `cell_optouts`' population. The
  equality was measured on 124,718 attributions (0 NULL, 0 mismatched), and
  `scripts/verify-audience-report.ts` re-asserts it on every run.
- **`REVOKE ALL … FROM anon, authenticated`.** Matviews carry no RLS. The app
  reads this one only through the helper below over `DATABASE_URL`, filtered by
  `org_id`, never through PostgREST.
- **A `report_refresh_log` row seeded NULL.** The page never reads it (see
  Refresh).
- **Cost:** the defining SELECT measured **5.3s** on production (2026-09-14).

## Refresh

Same cron as the offer report: `/api/cron/refresh-offer-group-report`, schedule
`0 5,20 * * *` (see [crons.md](crons.md)).

**Ordering.** `refreshOfferGroupReport()`
([lib/reporting/offer-group-report.ts](../../lib/reporting/offer-group-report.ts))
refreshes `audience_report_group_totals_mv` **last**, for two reasons that agree:
1. It sums `offer_group_report_mv`, so it must follow that refresh.
2. A deploy that precedes 0180 throws on this final statement, after the other
   three matviews have refreshed.

It then stamps the new matview's log row; the cron's log line reports
`audienceTotalsMs`.

**"Data as of"** on the page comes from `offer_group_report_mv`'s stamp
(`readGroupReportRefreshedAt()`). The totals are derived from those cells
moments later in the same run, so one stamp is honest for both. The stale
warnings are the offer report's: warn >16h, alert >26h. The Refresh button
re-fetches the snapshot; it does **not** rebuild it.

## API

`GET /api/reports/audience[?group_id=<id>]`
([app/api/reports/audience/route.ts](../../app/api/reports/audience/route.ts)):
- **Auth:** `requireApiMembership({ route: "reports/audience", method: "GET" })`,
  then `can(role, "campaigns.view")`, else 403. Route map: operator GET, token
  GET (same as `reports/performance`).
- **`group_id` absent:** returns `{ groups, report: null }`.
- **Not a positive integer:** 400.
- **Group not in the caller's org:** 404 — the multi-tenancy guard. There is no
  status filter, so an archived group keeps its report.
- **Otherwise:** `{ groups, report: { groupId, groupName, groupArchived, rows,
  groupTotals, orgBenchmark, benchmarkHasManual, breakEvenPer1k, refreshedAt } }`.

Read helper: [lib/reporting/audience-report.ts](../../lib/reporting/audience-report.ts)
exposes `getAudienceGroups(orgId)` and `getAudienceReport(orgId, groupId)`.
Every query is `org_id`-filtered. The offer name falls back to `Offer #<id>`
when the offer row is missing.

## UI

- **Columns:** Offer (+ Archived badge) · Sends · RPM · Net RPM · EPC · Sales ·
  Opt-out % · Net profit (economics labelled "(all time)") · Sent 7d / 30d /
  90d · Fresh pool.
- **Sorting:** every column, client-side. Default: Net RPM descending.
- **Colours:** Net RPM ≥ break-even is green, below is red. Opt-out % ≤2% green,
  2–3% amber, >3% red.
- **CSV:** client-side export of the benchmark, offer rows and totals.
- **Footnotes:**
  - Rows are tracked-campaign sends to recipients in the group.
  - Totals clicks/opt-outs are deduplicated across offers.
  - Contacts in several groups count in each group.
  - What Fresh pool means.
- **Shared helpers:** formatters, `derive()`, the colour helpers, `ManualMix`,
  `StaleBanner` and `downloadCsv` live in
  [components/reports/report-metrics.tsx](../../components/reports/report-metrics.tsx),
  shared with the offer report page (moved there, behaviour unchanged).

## Verification

[scripts/verify-audience-report.ts](../../scripts/verify-audience-report.ts) is
read-only. It prints its input scope first and treats an empty scope as a
failure.

- **a.** The totals' additive columns equal the sum of the group's cells.
- **b.** In one repeatable-read snapshot, the **shipped** matview definition
  (read from `pg_matviews`) sits within `[largest cell, sum of cells]` for
  clicks and opt-outs. Stored totals are also checked against the largest
  stored cell.
- **c.** Every opt-out's `opt_outs.contact_id` equals its attributed send's
  recipient.
- **d.** The helper returns exactly the matview's offer cells for every group,
  with archived flags matching.
- **e.** An org with no data sees nothing for a real group id.
- **f.** Neither anon nor authenticated can SELECT the matview, and its log row
  exists.

**Skips.** Stored-vs-stored comparisons (a, the stored half of b, and the
picker group set in d) skip with a stated reason when the cells were refreshed
after the totals.

## Files involved

- `db/migrations/0180_audience_report_group_totals.sql` (+ `meta/0180_snapshot.json`, `_journal.json`)
- `lib/reporting/audience-report.ts` — read helper
- `lib/reporting/offer-group-report.ts` — `readOrgBenchmark()`, `readGroupReportRefreshedAt()`, refresh ordering
- `app/api/reports/audience/route.ts` — API route; `lib/authz/route-map.ts` entry
- `app/api/cron/refresh-offer-group-report/route.ts` — `audienceTotalsMs` in the log line
- `app/(protected)/reports/audience/page.tsx`, `components/reports/audience-report.tsx` — page
- `components/reports/report-metrics.tsx` — helpers shared with `app/(protected)/offers/[id]/report/page.tsx`
- `components/reports/reports-tabs.tsx`, `components/protected/nav-config.ts`, `app/(protected)/reports/layout.tsx` — tab, sidebar row, section blurb
- `scripts/verify-audience-report.ts` — verification
