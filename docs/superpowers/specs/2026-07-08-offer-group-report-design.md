# Offer Group Performance Report — Design Spec

_Date: 2026-07-08 · Status: approved design, pending spec review_

## 1. Purpose

A read-only, per-offer report that breaks an offer's lifetime economics down by
**contact group**, plus current list-pressure (how hard each group is being
worked). One row per contact group the offer's campaigns have targeted, with a
global benchmark row on top and an offer-total row at the bottom. Opened from the
Offers list via a "Group Report" link on each offer row.

The report is a **historical decision aid**, not a live operational surface. Data
is precomputed twice a day; it is never used to drive live campaign configuration.

## 2. Scope

**In scope (v1):**
- Per-(offer, group) lifetime economics: sends, revenue, cost, sales, opt-outs,
  RPM, Net RPM, EPC, net profit, opt-out %.
- Per-group list pressure: distinct contacts sent in the last 7 / 30 / 90 days
  (across **all** offers).
- Fresh pool per group (contacts in the group never sent **this** offer and not
  opted out).
- A pinned **top benchmark row** (org-wide, all offers) and a pinned **bottom
  totals row** (this offer, all groups).
- CSV export of the loaded rows.

**Both tracked and manual campaigns are included in the economics.** A campaign's
send mode (`campaigns.link_mode`) only changes where its **Sends** count comes
from: tracked campaigns use per-recipient `stage_sends` rows; manual campaigns
(sent in the provider tool, count recorded as `campaign_stages.sms_count`, no
`stage_sends` rows) use `sms_count`. Revenue, sales, cost, clicks (EPC), and
opt-outs are drawn identically for both. This mirrors the `/reports` page's
"Total Sent" convention, so the numbers reconcile with it.

**Inherent data limitation (not a scoping choice):** the three per-contact
columns — **Sent last 7/30/90d** and **Fresh pool** — reflect **tracked sends
only**. They require per-recipient `stage_sends.contact_id` rows, which manual
campaigns do not produce. There is no per-recipient record of a manual send, so
these columns cannot account for them. Footnoted in the UI. (The economics
columns are unaffected — they include manual campaigns fully.)

**Out of scope (v1) — documented, easy to add later:**
- Proportional split of a multi-group campaign's numbers across its groups. v1
  counts each campaign **fully in every group** it targeted (see §5.4). Footnoted
  in the UI.
- Per-offer variant of the 7/30/90d columns (they are all-offers by design).
- User-selectable date range (the report is lifetime + fixed rolling windows).

## 3. Metric definitions (LOCKED — these are where bugs hide)

All figures are **lifetime** unless noted. Aggregation covers every campaign of
the target offer that has actually sent — i.e. has ≥1 `campaign_stages` row with
`sent_at IS NOT NULL` (tracked **and** manual). Drafts/unsent campaigns contribute
nothing.

| Metric | Definition |
|---|---|
| **Sends** | Per campaign, by send mode (mirrors `/reports` Total Sent): `campaigns.link_mode = 'tracked'` → `count(*)` of `stage_sends` rows with `sent_at IS NOT NULL`; otherwise (manual) → `Σ campaign_stages.sms_count` over stages with `sent_at IS NOT NULL`. |
| **Revenue** | `Σ keitaro_stage_results.revenue` per campaign. 100% Keitaro — there is no manual revenue (per `lib/reporting/attribution.ts`). |
| **Sales** | Per **stage**: `max(Σ keitaro_stage_results.sales, Σ stage_manual_sales.delta)` — the `max`, NOT the sum (a sale tallied both by Keitaro and manually is the SAME sale). Then `Σ` across the campaign's stages. Mirrors `combineSales` / the `/reports` route. |
| **Cost** | `Σ campaign_stages.total_cost` for stages with `sent_at IS NOT NULL`. NOT `keitaro_stage_results.cost` (always 0 here). |
| **Clicks (for EPC)** | Per row: `redirect_clicks_clean` when any of the four split columns > 0, else legacy `clean_clicks`. Summed. Mirrors `addRowToFunnel`'s `split` fallback in `lib/keitaro/funnel.ts`. |
| **Opt-outs** | `count(DISTINCT opt_out_id)` from `opt_out_attributions` per campaign (dedupes an opt-out attributed to multiple stages of the same campaign). |
| **RPM** | `revenue / sends * 1000` (revenue per 1,000 sends — "revenue per mille"). 0 sends ⇒ shown as "—". |
| **Net RPM** | `(revenue - cost) / sends * 1000`. |
| **EPC** | `revenue / clicks` (0 clicks ⇒ "—"). Matches `withFunnelDerived().epc`. |
| **Net profit** | `revenue - cost`. |
| **Opt-out %** | `optouts / sends * 100`. |
| **Sent last 7/30/90d** | `count(DISTINCT stage_sends.contact_id)` where the contact is in the group (`contact_contact_groups`) and has a `stage_sends.sent_at` within `now() - interval 'N days'`, **across all offers**. Windows are as-of the last refresh. **Tracked sends only** (manual sends have no per-recipient row — see §2). |
| **Fresh pool** | Contacts in the group with no `stage_sends` row for a campaign of **this** offer AND not present in `opt_outs`. **Tracked sends only**: a contact sent this offer *manually* is not visible here and may still count as fresh (see §2). |

Ratios on summary rows are always computed from **summed totals** (blended),
never an average of per-group ratios.

## 4. Data layer

No Postgres stored functions exist in this app; the convention is
`db.execute(sql\`…\`)` from a `lib/reporting/*.ts` helper. But because the heavy
part (list pressure over `stage_sends` ~500K ⋈ `contact_contact_groups` ~900K)
should run only twice a day, v1 precomputes into **materialized views** refreshed
by cron. Reads are then trivial index lookups.

### 4.1 Two materialized views + a refresh log

**`offer_group_report_mv`** — one row per `(org_id, offer_id, group_id)`:
`group_name`, `sends`, `revenue`, `sales`, `cost`, `clicks`, `optouts`,
`sent_7d`, `sent_30d`, `sent_90d`, `fresh_pool`.

Built from CTEs:
1. `per_campaign` — per sent campaign of every offer (tracked + manual): sends
   (link_mode-based per §3), revenue, sales (per-stage max then Σ), cost, clicks,
   optouts. Joins `campaigns` for `link_mode` + group ids and `campaign_stages`
   for `sms_count`/`sent_at`.
2. `camp_groups` — `per_campaign` × `unnest(campaigns.audience_contact_group_ids)`.
3. `econ` — sum `camp_groups` by `(org_id, offer_id, group_id)`.
4. `list_pressure` — per `(org_id, group_id)`, distinct-contact 7/30/90d counts
   (all offers). Joined in; same value repeats across a group's offer rows
   (`max()`-safe, one row per group — cannot double-count).
5. `fresh` — per `(org_id, offer_id, group_id)` fresh-pool count.
6. Final `SELECT` joins `contact_groups` for `group_name`.

**`offer_report_org_summary_mv`** — one row per `org_id`: `sends`, `revenue`,
`sales`, `cost`, `clicks`, `optouts`. De-duplicated: aggregated from
`per_campaign` by `org_id` only (each campaign counted once, NO group unnest), so
multi-group campaigns are not double-counted. Powers the top benchmark row.

**`report_refresh_log`** table — `(view_name text PK, refreshed_at timestamptz)`.
Updated by the cron on each successful refresh; read for the "data as of" line.

### 4.2 Indexes & migration

Hand-authored migration (per repo convention: write SQL, clone the snapshot
forward, add the journal entry, `db:migrate`, then
`verify-migration-integrity.ts`). Contents:
- Both matviews + a **unique index** on each (`(org_id, offer_id, group_id)` and
  `(org_id)`) — required for `REFRESH … CONCURRENTLY`.
- `report_refresh_log` table, seeded with the two view names.
- Supporting indexes (finalize via `EXPLAIN` during implementation):
  `stage_sends (sent_at, contact_id)`, `stage_sends (campaign_id)` if absent,
  `contact_contact_groups (contact_group_id, contact_id)` (the PK is
  `(contact_id, contact_group_id)` — good for the list-pressure join, but the
  reverse is needed for "all contacts in a group" / fresh pool).
  `keitaro_stage_results (campaign_id, stat_date)` already exists.

### 4.3 Multi-tenancy

Postgres matviews cannot carry RLS. Org isolation is enforced exactly as every
other Drizzle query in this app: the API route filters `WHERE org_id = ${auth.orgId}`.
The matviews are server-only (never exposed to the client directly). This matches
CLAUDE.md §3 ("application-level filtering is the primary defense").

## 5. Refresh (Vercel Cron)

- One cron entry `0 5,20 * * *` (05:00 & 20:00 UTC) → `GET /api/cron/refresh-offer-group-report`.
- Gated by the existing `CRON_SECRET` header pattern used by the other crons.
  `export const maxDuration = 60`.
- Handler: `REFRESH MATERIALIZED VIEW CONCURRENTLY offer_group_report_mv;`
  then the org-summary view; then upsert both rows in `report_refresh_log`.
- **DST note:** Vercel cron is fixed-UTC. `0 5,20` lands at **00:00 & 15:00 ET in
  winter (EST)** exactly, and **01:00 & 16:00 ET in summer (EDT)** — a ~1h drift
  that is irrelevant for a twice-daily historical report. Documented, not fixed.

## 6. API route

`GET /api/offers/[id]/report`:
- `requireApiMembership()` → `can(auth.role, "offers.view")` (viewer+), else 403.
- Reads `offer_group_report_mv WHERE org_id = auth.orgId AND offer_id = :id`,
  the matching `offer_report_org_summary_mv` row, both `report_refresh_log` rows,
  and the offer's name.
- Computes `breakEvenPer1k = totalCost / totalSends * 1000` from the offer totals.
- Returns `{ offerName, data: GroupRow[], offerTotals, orgBenchmark, breakEvenPer1k, refreshedAt }`.
- Read-only. No writes. No poll trigger.

## 7. UI

### 7.1 Page

`app/(protected)/offers/[id]/report/page.tsx` — client component modeled on
`app/(protected)/reports/page.tsx`, but rendered as a **custom lightweight
sortable table** (not the `DataTable` wrapper, which can't pin rows or foot a
table). Justified by the tiny per-offer row count (tens of groups).

- **Columns (in order):** Group · Sends · RPM · Net RPM · EPC · Sales ·
  Opt-out % · Net profit · Sent 7d · Sent 30d · Sent 90d · Fresh pool.
- **Default sort:** Net RPM desc. All columns sortable (client-side — full set is
  already loaded).
- **Top pinned row — "All offers (org-wide)":** benchmark from
  `orgBenchmark`. Windows/Fresh-pool cells show "—".
- **Bottom pinned row — "This offer · all groups":** foots the visible group
  columns (multi-group campaigns counted fully in each group — same footnote).
- **Color coding:** Net RPM ≥ break-even → green, below → red (break-even =
  computed blended `cost/1k`, not hard-coded). Opt-out %: ≤2% green, 2–3% amber,
  >3% red. Uses `text-emerald-600` / amber / `text-destructive`, `tabular-nums`.
- **Header:** offer name, "data as of {formatCampaignDateTime(refreshedAt)}", a
  **Refresh** button (re-fetches the matview; does NOT rebuild it), and a CSV
  export button (client-side, small dataset).
- **Footnote:** "A campaign that targets multiple groups is counted fully in each
  group; group rows may therefore sum to more than the org-wide total."

### 7.2 Entry point

In `app/(protected)/offers/page.tsx`, add a visible **"Group Report"** link in
each offer row's action area, before the `⋯` dropdown (matching the provided
screenshot — a link, not a dropdown item). `<Link href={\`/offers/${offer.id}/report\`}>`.
Visible to anyone with `offers.view`.

## 8. Docs to update (mandatory per CLAUDE.md)

- `docs/03-data-model.md` + Mermaid ERD — two matviews, `report_refresh_log`, new indexes.
- `docs/04-features/` — new feature doc for the Offer Group Report.
- `docs/06-integrations.md` — new Vercel cron.
- `docs/07-conventions.md` — metric definitions (§3), multi-group counting rule,
  DST drift, manual-campaign exclusion.
- `docs/CHANGELOG.md` — one-line entry.
- Bump "last updated" on every touched doc.

## 9. Verification criteria

1. For offer 62 (Kinzeno 14508), group rows reproduce the brief's shape (Memory
   highest RPM, Manifestation highest opt-out, etc.). **Numbers will differ from
   the brief's Keitaro-only acceptance figures** because sales use the
   Keitaro+manual `max` convention (user's explicit choice) — verify the deltas
   are explained by manual sales, not by a join error.
2. A campaign with two groups in `audience_contact_group_ids` appears fully in
   both group rows; the offer-total row foots the visible columns.
3. A **manual** campaign contributes to Sends/RPM/Sales/etc. (via `sms_count`)
   but adds nothing to the 7/30/90d and Fresh-pool columns.
5. "Sent last X days" for a group never exceeds the group's total contact count.
6. Org-benchmark row's totals are de-duplicated (do NOT equal the sum of group
   rows when multi-group campaigns exist).
7. Refresh cron completes < 60s; `report_refresh_log` timestamps advance; the
   page's "data as of" reflects them.
8. Route is read-only, org-scoped (a second org sees only its own data), and
   surfaces only names/slugs — never internal numeric IDs.
9. `verify-migration-integrity.ts` is green after the migration.

## 10. Open risks

- **Refresh runtime at scale.** If `REFRESH CONCURRENTLY` of `offer_group_report_mv`
  (driven by the fresh-pool anti-join across all offers × groups) approaches the
  60s function budget, fall back to non-concurrent refresh at the off-peak cron
  time, or split fresh-pool into its own view. Validate with `EXPLAIN ANALYZE`
  during implementation before committing to CONCURRENTLY.
