# Audience Report — offer results per contact group

_Design spec · 2026-09-14 · branch `feat/audience-report` · ClickUp [869eydqn0](https://app.clickup.com/t/869eydqn0)_

> **Every figure here is a snapshot measured against production on 2026-09-14**
> (recon read at `origin/main` = `bc26b81`). The matviews refresh twice daily;
> the numbers show the mechanism and its size and are not expected values. No
> verification criterion in §8 compares against a constant from this document.

## 1. Goal

> As a CamMan manager I want to see the statistics of each contact group,
> showing the results of the offers used against it — similar to the offer
> report, but with the contact group as the main filter, and including archived
> offers — to understand which offers work better for each group.

The offer report (`/offers/[id]/report`, [offer-group-report.md](../../04-features/offer-group-report.md))
answers "for this offer, which group?". This report answers the inverse: "for
this group, which offer?".

## 2. Decisions (agreed 2026-09-14)

| # | Question | Decision |
|---|---|---|
| D1 | Row grain | **One row per offer.** No offer category/type exists (`offers` has no such column) and none is added. A category roll-up is not planned. |
| D2 | Placement | **New `/reports` tab "Audience"** at `/reports/audience`, with a searchable contact-group picker as the main filter. |
| D3 | Totals row | **Accurate "This group · all offers" row from a new matview**, so the row's EPC and opt-out % are deduplicated at group grain. |

## 3. Why it is mostly a read of existing data

`offer_group_report_mv` (migrations 0132/0133) is already keyed
`(org_id, offer_id, group_id)` and never filters on offer or group status. The
offer rows of this report are that matview filtered to one group.

Measured: 138 cells, 16 groups with data, 28 offers; up to 17 (avg 8.6) offers
per group. **10 archived offers (16 cells) and 4 archived groups are already in
it** — the archived requirement holds as long as no status filter is added.

Only the totals row needs new data, because two columns are not additive across
offers within a group:

- **Clicks.** A contact who clicked two offers is one clicker in the group.
  Summing the cells overcounts by 25–50% on the large groups (Memory 32,719
  summed vs 23,815 distinct, +37.4%; Blood Sugar +49.8%).
- **Opt-outs.** `opt_out_attributions` is unique on `(opt_out_id, stage_id)`,
  so one opt-out *may* be credited to several stages. Today 0 of 124,717 are,
  but that is today's data, not a structural guarantee — the row counts
  distinct opt-outs instead of relying on it.

Sends, revenue, sales, cost and `sent_7d/30d/90d` **are** additive across a
group's cells: every `stage_sends` row belongs to exactly one stage → campaign →
offer, and appears at most once per group.

## 4. Data layer — migration 0180

### 4.1 `audience_report_group_totals_mv` (materialized, UNIQUE `(org_id, group_id)`)

```sql
CREATE MATERIALIZED VIEW public.audience_report_group_totals_mv AS
WITH sums AS (          -- additive columns, from the offer x group cells
  SELECT org_id, group_id,
         SUM(sends)::bigint, SUM(revenue)::numeric(14,4), SUM(sales)::bigint,
         SUM(cost)::numeric(14,4),
         SUM(sent_7d)::bigint, SUM(sent_30d)::bigint, SUM(sent_90d)::bigint
  FROM public.offer_group_report_mv
  GROUP BY org_id, group_id
),
g_clicks AS (           -- distinct clickers at GROUP grain
  SELECT camp.org_id, ccg.contact_group_id AS group_id,
         COUNT(DISTINCT cc.contact_id)::bigint AS n
  FROM public.counted_clickers cc
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = cc.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = cc.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
   AND ccg.org_id = camp.org_id
  GROUP BY 1, 2
),
g_optouts AS (          -- distinct opt-outs at GROUP grain
  SELECT camp.org_id, ccg.contact_group_id AS group_id,
         COUNT(DISTINCT oa.opt_out_id)::bigint AS n
  FROM public.opt_out_attributions oa
  JOIN public.opt_outs o ON o.id = oa.opt_out_id
  JOIN public.campaign_stages cs ON cs.id = oa.stage_id
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = cs.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = o.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
   AND ccg.org_id = camp.org_id
  WHERE oa.stage_send_id IS NOT NULL
  GROUP BY 1, 2
)
SELECT s.*, COALESCE(k.n, 0) AS clicks, COALESCE(x.n, 0) AS optouts
FROM sums s
LEFT JOIN g_clicks  k USING (org_id, group_id)
LEFT JOIN g_optouts x USING (org_id, group_id);
```

The SQL is a sketch; column names in the final migration match
`offer_group_report_mv`'s (`sends`, `revenue`, `sales`, `cost`, `clicks`,
`optouts`, `sent_7d`, `sent_30d`, `sent_90d`).

**Scope mirrors the cells exactly.** Clicks and opt-outs use the same
`offer_report_tracked_campaigns` universe and the same `= ANY(camp.gids)`
membership rule as `offer_group_report_mv`'s `cell_clicks` / `cell_optouts`.
This is so that, per group, `max(cell) ≤ total ≤ sum(cells)` holds.

**Opt-out recipient comes from `opt_outs.contact_id`, not `stage_sends`.**
The cell CTE reaches the recipient through `stage_sends` (124,688 primary-key
lookups on a multi-million-row table): **36.8s**. Reading it from `opt_outs`:
**0.57s**, same rows. `WHERE oa.stage_send_id IS NOT NULL` keeps the cell
CTE's population (it inner-joins `stage_sends`). Equivalence measured: across
124,718 attributions with a send, `opt_outs.contact_id` is never NULL and never
differs from `stage_sends.contact_id` (0 mismatches). That equality is an
invariant ("an opt-out's contact is the recipient of the send it is credited
to"), so §8 asserts it on every run.

**Cost:** clicks CTE 1.8s, opt-outs CTE 0.57s, sums over 138 rows negligible —
a few seconds against a refresh last measured at ~104s (2026-08-14) of its 300s
budget. The final number is measured on the first refresh (§8 V5); a plain
`SELECT` understates `REFRESH … CONCURRENTLY`.

### 4.2 Rest of the migration

- `CREATE UNIQUE INDEX audience_report_group_totals_mv_key_uniq ON … (org_id, group_id)`
  — required by `REFRESH … CONCURRENTLY`.
- `REVOKE ALL ON public.audience_report_group_totals_mv FROM anon, authenticated;`
  Matviews carry no RLS; the three existing report matviews are still readable
  through `/rest/v1` with the public anon key (open item in
  [security-notes.md](../../security-notes.md)). The app never reads report
  tables through PostgREST (zero `supabase.from(...)` calls), so revoking
  breaks nothing. The existing three are **out of scope** here (§10).
- `INSERT INTO report_refresh_log (view_name, refreshed_at) VALUES ('audience_report_group_totals_mv', NULL)`
  — seeded NULL per the 0093/0132 convention; the page never reads this row
  (§5.3).
- Hand-authored: SQL + cloned snapshot with fixed `id`/`prevId` + journal entry.
  `0180` is the next free number on `origin/main` and in open PRs.

### 4.3 Refresh

`refreshOfferGroupReport()` ([lib/reporting/offer-group-report.ts](../../../lib/reporting/offer-group-report.ts))
refreshes the new matview **last**, after `offer_report_offer_totals_mv`, and
stamps its `report_refresh_log` row right after it succeeds. Last matters for
two reasons, and they agree:

1. It reads `offer_group_report_mv`, so it must run after that refresh.
2. Deploy-order blast radius: if code ever ships before 0180, the missing
   relation throws on the last statement, so the three existing matviews still
   refresh.

`RefreshDurations` gains `audienceTotalsMs`; the cron's log line includes it.
Accepted skew: totals-row clicks/opt-outs are read a minute or two after the
cells' — the same class of skew the offer report's footer already documents.

## 5. Read helper and API

### 5.1 `lib/reporting/audience-report.ts`

No `"server-only"` import (matching `offer-group-report.ts`, so tsx scripts can
call it). Every query is `WHERE org_id = ${orgId}::uuid`.

- `getAudienceGroups(orgId)` → `{ id, name, archived }[]` — groups present in
  `audience_report_group_totals_mv`, joined to `contact_groups` for the current
  name and status. Active first, then by name.
- `getAudienceReport(orgId, groupId)` →
  `{ rows, groupTotals, orgBenchmark, benchmarkHasManual, refreshedAt }`
  - `rows`: `offer_group_report_mv` cells for the group, `LEFT JOIN offers`
    on `(id, org_id)` for `offer_name` and `offer_archived`, with **no status
    filter**. If the offer row is missing, the name falls back to `Offer #<id>`.
  - `groupTotals`: the group's `audience_report_group_totals_mv` row, or zeros
    if the group has no data.
  - `orgBenchmark` / `benchmarkHasManual`: `offer_report_org_summary_mv`
    (unchanged, same read as the offer report).
  - `refreshedAt`: `report_refresh_log` for `offer_group_report_mv` — the
    cells' snapshot, which the totals are derived from.
- Metric types reuse `RawMetrics` from `offer-group-report.ts`.

### 5.2 `GET /api/reports/audience?group_id=<id>`

- Auth: same call shape and permission as `app/api/reports/performance/route.ts`
  — `campaigns.view` (viewer+), like every `/reports` tab.
- `group_id` absent → `{ groups, report: null }`.
- `group_id` not a positive integer → 400. Group not in the caller's org → 404
  (the multi-tenancy guard; another org's id 404s rather than leaking).
- Otherwise → `{ groups, report: { groupId, groupName, groupArchived, rows,
  groupTotals, orgBenchmark, benchmarkHasManual, breakEvenPer1k, refreshedAt } }`,
  where `breakEvenPer1k = groupTotals.cost / groupTotals.sends * 1000`, or null
  at 0 sends.
- `lib/authz/route-map.ts`: `"reports/audience": { methods: ["GET"], token: ["GET"] }`
  (mirrors `reports/performance`).

### 5.3 Freshness

The page shows "Data as of" from `offer_group_report_mv`'s log row, with the
offer report's staleness thresholds (warn >16h, alert >26h). The totals matview
refreshes seconds after it in the same cron run, so one timestamp is honest for
both.

## 6. UI

- **Route:** `app/(protected)/reports/audience/page.tsx` (static segment; beats
  `[dimension]`). Client component `components/reports/audience-report.tsx`.
- **Tabs:** an explicit "Audience" entry in `components/reports/reports-tabs.tsx`
  (like Delivery — not a `REPORT_DIMENSIONS` member). A sidebar item goes in
  the Reports group of `components/protected/nav-config.ts`
  (`permission: "campaigns.view"`).
- **Picker:** `<SearchableSelect>` (16 groups with data today, more than the
  10-option threshold for a plain `<Select>`). Archived groups are labelled
  `"<name> (archived)"`. The selection lives in the URL as `?group=<id>`, so a
  reload or shared link reopens it; with no group selected, an empty state
  prompts "Pick a contact group".
- **Header:** group name, "Data as of …", break-even `$/1k`, stale banner,
  Refresh (re-fetches the snapshot; does not rebuild it) and CSV (client-side).
- **Columns:** Offer (name + "Archived" badge) · Sends · RPM · Net RPM · EPC ·
  Sales · Opt-out % · Net profit · Sent 7d · Sent 30d · Sent 90d · Fresh pool.
  Economics are labelled "(all time)" as on the offer report. All columns sort
  client-side; default sort is Net RPM descending.
- **Pinned rows:** top "All offers · all groups (org-wide)" (`+manual` badge when
  `benchmarkHasManual`); bottom "This group · all offers" from `groupTotals`,
  with Fresh pool "—". Its Sent 7d/30d/90d are the group sums.
- **Colors:** Net RPM ≥ break-even is green, below is red (none when break-even
  is null). Opt-out % ≤2 green, 2–3 amber, >3 red — same as the offer report.
- **Empty group:** "No offer data for this group yet."
- **Footnotes:**
  1. Rows count tracked-campaign sends to recipients in this group;
     manual-link campaigns cannot be attributed to a group.
  2. A contact in several groups appears in each group's report, so groups do
     not add up to the org benchmark.
  3. The bottom row counts each clicker and opt-out once across offers, so its
     clicks/opt-outs are lower than the sum of the rows.
  4. Fresh pool = sendable contacts in this group never sent that offer.
- **Shared code:** the pure helpers currently inline in the offer report page —
  `derive()`, the number formatters, `refreshAge()`, `netRpmClass()`,
  `ooClass()`, `ManualMix` — move to a client-safe `components/reports/report-metrics.tsx`
  (no DB import) and both pages import them. This is a pure move; the offer
  report's rendering must not change.

## 7. Metric definitions

Every offer-row metric is **identical** to the offer report's group-row metric
for the same `(offer, group)` cell. It is the same matview row;
see [offer-group-report.md](../../04-features/offer-group-report.md#metric-definitions-locked).

| Totals-row metric | Definition |
|---|---|
| Sends, Revenue, Sales, Cost, Sent 7d/30d/90d | `SUM` over the group's cells (additive: one send → one offer) |
| Clicks (EPC denominator) | `COUNT(DISTINCT counted_clickers.contact_id)` over tracked campaigns that targeted the group, recipient in the group |
| Opt-outs | `COUNT(DISTINCT opt_out_id)` over the same scope, recipient via `opt_outs.contact_id` |
| RPM / Net RPM / EPC / Net profit / Opt-out % | derived from the row's own totals, never averaged across offers |
| Fresh pool | "—" (offer-scoped quantity; no group-wide meaning) |

## 8. Verification criteria

- **V1 Static:** `tsc` clean; `npx eslint` on changed files adds zero problems
  (baseline-compare the offer report page); `scripts/test-route-map-coverage.ts`
  passes; `next build` passes.
- **V2 `scripts/verify-audience-report.ts`** (read-only; every check computes
  both sides in the same run):
  - a. **Sums.** Per group: `audience_report_group_totals_mv` additive columns
    equal `SUM` over that group's `offer_group_report_mv` cells. Skipped with a
    printed reason if `report_refresh_log` shows the cells refreshed after the
    totals (a refresh in progress).
  - b. **Dedup logic.** In one `REPEATABLE READ` transaction, recompute
    per-cell and per-group distinct clickers and opt-outs from source tables.
    Assert `max(cell) ≤ group ≤ sum(cells)` per group, and print how many
    groups actually exercise the dedup (`group < sum`).
  - c. **Recipient invariant.** 0 attributions where `opt_outs.contact_id` is
    distinct from the attributed `stage_sends.contact_id`.
  - d. **Archived included.** `getAudienceReport(org, g).rows` offer ids equal
    the set of `offer_group_report_mv` offer ids for `(org, g)`, for every
    group (set equality; prints the archived count, never asserts it).
  - e. **Org scoping.** The helpers called with an org that owns no data
    return no groups and no rows.
  - f. **Grants.** `pg_class.relacl` of the new matview grants nothing to
    `anon` / `authenticated`.
- **V3 API:** `group_id` missing → `report: null`; `abc` → 400; another org's
  group id → 404.
- **V4 UI** (Playwright on the PR preview):
  - The Audience tab and sidebar item appear.
  - The picker marks archived groups.
  - Selecting a group shows offer rows including an Archived badge, both
    pinned rows, working sort and CSV.
  - `?group=` survives a reload.
  - An operator login loads the tab (no denied fetch).
  - The offer report page renders unchanged after the helper move.
- **V5 Refresh cost:** `audienceTotalsMs` from the first cron run after
  migration (or a manual trigger, with approval) is recorded in the feature
  doc, and total refresh stays under the 300s budget.

## 9. Release order and docs

1. Migration 0180 is **additive** and leads the code. It is applied to prod with
   `npm run db:migrate` **only after the user approves**, then
   `scripts/verify-migration-integrity.ts`. The preview project auto-applies it
   for the PR preview.
2. Merge the code after prod has 0180.
3. Docs (same PR):
   - new `docs/04-features/audience-report.md`
   - `docs/03-data-model.md`: Reporting table row plus the derived-objects note
   - `docs/04-features/crons.md`: the refresh now covers four matviews
   - `docs/04-features/offer-group-report.md`: refresh sequence plus a link
   - `docs/07-conventions.md`: group totals never sum clicks/opt-outs across
     offers; opt-out recipient via `opt_outs.contact_id` and why
   - `docs/security-notes.md`: new matview revoked, existing three still open
   - `docs/CHANGELOG.md` entry, and last-updated dates
   - No flow or integration change: `05-flows.md` and `06-integrations.md` are
     untouched.

## 10. Out of scope

- Offer category/type field or roll-up (D1).
- Date-range filter — lifetime only, like the offer report (recorded decision in
  [epc-denominator.md](../../04-features/epc-denominator.md)).
- Manual-link campaigns in group rows (no per-recipient rows to attribute).
- Per-row "vs this offer's all-group average" comparison.
- Revoking `anon`/`authenticated` on the three existing report matviews — a
  separate hardening change unless folded in on request.

## 11. Files

| File | Change |
|---|---|
| `db/migrations/0180_audience_report_group_totals.sql` + `meta/0180_snapshot.json` + `meta/_journal.json` | new matview, index, revoke, refresh-log seed |
| `lib/reporting/offer-group-report.ts` | refresh the new matview last; `audienceTotalsMs` |
| `app/api/cron/refresh-offer-group-report/route.ts` | log line |
| `lib/reporting/audience-report.ts` | new read helper |
| `app/api/reports/audience/route.ts` | new API route |
| `lib/authz/route-map.ts` | `reports/audience` entry |
| `app/(protected)/reports/audience/page.tsx` | new page (title + client component) |
| `components/reports/audience-report.tsx` | new client component |
| `components/reports/report-metrics.tsx` | shared pure helpers (moved) |
| `app/(protected)/offers/[id]/report/page.tsx` | import the moved helpers |
| `components/reports/reports-tabs.tsx`, `components/protected/nav-config.ts` | tab + sidebar entry |
| `scripts/verify-audience-report.ts` | V2 checks |
| docs per §9 | |
