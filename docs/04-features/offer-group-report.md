# Offer Group Performance Report

_Last updated: 2026-07-08_

A read-only, per-offer report that breaks an offer's **lifetime** economics down
by contact group, plus current list-pressure (how hard each group is being
worked). One row per contact group the offer's campaigns have targeted, a pinned
org-wide benchmark row on top, and a pinned offer-total row at the bottom.

It is a **historical decision aid**, not a live operational surface — the
underlying data is precomputed twice a day (see Refresh below) and is never used
to drive live campaign configuration or gate any action.

## Entry point

`/offers/[id]/report` ([app/(protected)/offers/[id]/report/page.tsx](../../app/(protected)/offers/[id]/report/page.tsx)),
opened via a **"Group Report"** link on each row of the Offers list
([app/(protected)/offers/page.tsx](../../app/(protected)/offers/page.tsx)),
before the row's `⋯` actions dropdown. Visible to anyone with `offers.view`
(viewer role and up) — same permission as the rest of the offer registry.

## Metric definitions (LOCKED)

Aggregation covers every campaign of the offer with ≥1 sent stage
(`campaign_stages.sent_at IS NOT NULL`), **tracked and manual alike**,
`offer_id` non-null. Drafts/unsent campaigns contribute nothing. Ratios on the
pinned summary rows are always computed from **summed totals** (blended), never
an average of per-group ratios.

| Metric | Definition |
|---|---|
| **Sends** | Per campaign, by `campaigns.link_mode` (mirrors the `/reports` "Total Sent" convention): `tracked` → `count(*)` of `stage_sends` rows with `sent_at IS NOT NULL`; `manual` → `Σ campaign_stages.sms_count` over stages with `sent_at IS NOT NULL`. |
| **Revenue** | `Σ keitaro_stage_results.revenue` per campaign. 100% Keitaro — there is no manual revenue source. |
| **Sales** | Per **stage**: `GREATEST(Σ keitaro_stage_results.sales, Σ stage_manual_sales.delta)` — the **max**, never the sum (a sale tracked both by Keitaro and tallied manually is the SAME sale) — then summed across the campaign's stages. Same convention as `combineSales` / the `/reports` page. |
| **Cost** | `Σ campaign_stages.total_cost` for stages with `sent_at IS NOT NULL`. **Not** `keitaro_stage_results.cost` (always 0 — that column is Keitaro ad-platform spend, not ours; see [07-conventions.md](../07-conventions.md)). |
| **Clicks (EPC denominator)** | Per `keitaro_stage_results` row: `redirect_clicks_clean` when any of the four split columns is `> 0`, else the legacy `clean_clicks`. Summed. |
| **Opt-outs** | `COUNT(DISTINCT opt_out_id)` from `opt_out_attributions` per campaign (dedupes an opt-out attributed to more than one stage of the same campaign). |
| **RPM** | `revenue / sends * 1000`. 0 sends ⇒ shown as "—". |
| **Net RPM** | `(revenue - cost) / sends * 1000`. |
| **EPC** | `revenue / clicks`. 0 clicks ⇒ "—". |
| **Net profit** | `revenue - cost`. |
| **Opt-out %** | `optouts / sends * 100`. |
| **Sent last 7 / 30 / 90 days** | `COUNT(DISTINCT stage_sends.contact_id)` where the contact is in the group (`contact_contact_groups`) and has a `stage_sends.sent_at` within the window, **across all offers**, as of the last refresh. |
| **Fresh pool** | Contacts in the group with no `stage_sends` row for a campaign of **this** offer, AND not present in `opt_outs`. |

## Manual campaigns and the per-contact-column limitation

**Both tracked and manual campaigns are included in the economics** — a
campaign's `link_mode` only changes where its Sends figure comes from (see
table above). Revenue, Sales, Cost, Clicks, and Opt-outs are computed
identically for both modes.

**The three per-contact columns — Sent 7d / 30d / 90d and Fresh pool — are
computed from per-recipient `stage_sends` rows.** Every send made through the
app's send pipeline (the in-app "Send…" action *or* the scheduled auto-send)
writes one of these rows **regardless of `link_mode`** — tracked and manual
in-app sends both count. The only sends invisible to these four columns are
ones performed **entirely outside the app**, where an operator hand-recorded a
`campaign_stages.sms_count` with no corresponding per-recipient row. This is an
inherent data limitation, not a scoping choice, and is footnoted in the UI. The
economics columns are unaffected — they include those external sends via
`sms_count`.

**Multi-group campaigns are counted FULLY in each targeted group** (v1 does not
proportionally split a campaign's numbers across its groups) — group rows can
therefore sum to more than the org-wide benchmark row, which de-duplicates each
campaign to one count. Footnoted in the UI; not a bug.

## Data layer (migration 0093)

No Postgres stored functions exist in this app — the convention is
`db.execute(sql\`…\`)` from a `lib/reporting/*.ts` helper. Because the
list-pressure/fresh-pool joins (`stage_sends` ⋈ `contact_contact_groups`, both
large tables) are too heavy to run per page load, v1 precomputes into
**materialized views**, refreshed by cron; reads are then trivial index
lookups.

- **`offer_report_campaign_econ`** (plain view) — per-campaign economics; shared
  source CTE for both matviews below.
- **`offer_group_report_mv`** (materialized, unique on `(org_id, offer_id, group_id)`)
  — per org×offer×group rollup, plus the three list-pressure windows and the
  fresh pool count.
- **`offer_report_org_summary_mv`** (materialized, unique on `org_id`) — the
  de-duplicated org-wide benchmark row.
- **`report_refresh_log`** — `(view_name, refreshed_at)`, one row per matview,
  read for the page's "data as of" line.
- Supporting indexes: `stage_sends (sent_at, contact_id)`,
  `contact_contact_groups (contact_group_id, contact_id)`.

Full column lists and the no-RLS note are in
[03-data-model.md](../03-data-model.md#reporting-migration-0093).

`lib/reporting/offer-group-report.ts` exposes two functions:
- `getOfferGroupReport(orgId, offerId)` — reads both matviews (org-scoped) and
  the refresh log, shapes the result into `{ rows, orgBenchmark, refreshedAt }`.
- `refreshOfferGroupReport()` — runs `REFRESH MATERIALIZED VIEW CONCURRENTLY`
  on both matviews (two separate statements — `CONCURRENTLY` cannot run inside
  an explicit transaction) then stamps both `report_refresh_log` rows with
  `now()`.

## Refresh (twice-daily cron)

`GET/POST /api/cron/refresh-offer-group-report`
([app/api/cron/refresh-offer-group-report/route.ts](../../app/api/cron/refresh-offer-group-report/route.ts)),
schedule **`0 5,20 * * *`** (registered in `vercel.json`), `CRON_SECRET`-gated
(`Authorization: Bearer` or `x-cron-secret` header, same pattern as the other
crons — see [crons.md](crons.md)), `export const maxDuration = 300`.

The 300s budget (not 60s) reflects measurement: the full `CONCURRENTLY` refresh
of both matviews ran ~50s worst-case (cold) / ~37s warm against production
data — a 60s ceiling left no cold-start headroom. This is a background job with
no user waiting on it, so the larger budget costs nothing.

**DST drift:** Vercel Cron schedules are fixed-UTC. `0 5,20 * * *` lands at
**00:00 & 15:00 ET** in winter (EST) and **01:00 & 16:00 ET** in summer (EDT) —
a ~1h drift across the DST transition. Irrelevant for a twice-daily historical
report; documented, not corrected (same tradeoff already accepted for the
Telegram report's Warsaw-time cron — see [crons.md](crons.md)).

## API

`GET /api/offers/[id]/report`
([app/api/offers/[id]/report/route.ts](../../app/api/offers/[id]/report/route.ts)):
- `requireApiMembership()` → `can(role, "offers.view")`, else 403.
- Validates `id` as a positive integer (400 otherwise), then checks the offer
  exists **and** belongs to the caller's org (404 otherwise — also the
  multi-tenancy guard; an id from another org 404s instead of leaking).
- Calls `getOfferGroupReport(orgId, offerId)`.
- Computes `offerTotals` by summing the visible group rows (foots the table;
  inherits the multi-group-counted-twice caveat above) and
  `breakEvenPer1k = offerTotals.cost / offerTotals.sends * 1000` (null at 0
  sends).
- Returns `{ offerName, rows, offerTotals, orgBenchmark, breakEvenPer1k, refreshedAt }`.
  Read-only — no writes, no on-demand refresh trigger.

## UI

[app/(protected)/offers/[id]/report/page.tsx](../../app/(protected)/offers/[id]/report/page.tsx)
— a lightweight custom sortable table (not the `DataTable` wrapper, which can't
pin rows or foot a table; justified by the small per-offer row count).

- **Columns:** Group · Sends · RPM · Net RPM · EPC · Sales · Opt-out % · Net
  profit · Sent 7d · Sent 30d · Sent 90d · Fresh pool. Default sort: Net RPM
  descending. All columns sortable client-side (the full row set is already
  loaded).
- **Pinned top row** — "All offers (org-wide)": the de-duplicated
  `orgBenchmark`; the per-contact-window/fresh-pool cells show "—".
- **Pinned bottom row** — "This offer · all groups": `offerTotals`, footed from
  the visible group rows.
- **Color coding:** Net RPM ≥ break-even → green, below → red (break-even is
  the blended `cost/1k`, not hard-coded); a `null` break-even (0 total sends)
  renders with no color. Opt-out %: ≤2% green, 2–3% amber, >3% red.
- **Header:** offer name, "data as of {formatCampaignDateTime(refreshedAt)}", a
  Refresh button (re-fetches the current matview snapshot — does **not**
  rebuild it), a CSV export button (client-side, small dataset).
- **Footnote:** a campaign targeting multiple groups is counted fully in each
  group; group rows may therefore sum to more than the org-wide total.

## Files involved

- `db/migrations/0093_offer_group_report.sql` — the view, two matviews,
  `report_refresh_log`, and the two supporting indexes.
- `lib/reporting/offer-group-report.ts` — read + refresh helper.
- `app/api/offers/[id]/report/route.ts` — the API route.
- `app/api/cron/refresh-offer-group-report/route.ts` — the twice-daily refresh cron.
- `app/(protected)/offers/[id]/report/page.tsx` — the report page.
- `app/(protected)/offers/page.tsx` — the "Group Report" entry-point link.
- `vercel.json` — cron registration.
