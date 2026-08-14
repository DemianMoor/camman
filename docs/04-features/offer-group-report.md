# Offer Group Performance Report

_Last updated: 2026-08-14_

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

The **offer total row** aggregates every campaign of the offer with ≥1 sent
stage (`campaign_stages.sent_at IS NOT NULL`), **tracked and manual alike**,
`offer_id` non-null — unchanged since migration 0093. The **org benchmark
row** aggregates that same sent-stage universe org-wide with **no `offer_id`
filter** — campaigns with no offer set are still counted in it.
**Group rows are narrower** (migration 0132): only `link_mode='tracked'`
campaigns contribute, because a manual-mode campaign's `sms_count` has no
per-recipient row to attribute to a group (see "Tracked-only attribution"
below). Drafts/unsent campaigns contribute nothing either way. Ratios on the
pinned summary rows are always computed from **summed totals** (blended), never
an average of per-group ratios.

| Metric | Definition |
|---|---|
| **Sends** | Group row: `COUNT(*)` of `stage_sends` rows with `status='sent'` whose recipient is in the group AND whose campaign targeted it (`link_mode='tracked'` only). Footer/benchmark: campaign-grain, per `campaigns.link_mode` — `tracked` → `stage_sends` count, `manual` → `Σ campaign_stages.sms_count`. |
| **Revenue** | Group row: `Σ stage_sends.sale_revenue` over the same attributed rows. Footer: `Σ keitaro_stage_results.revenue`. Per-recipient covers ~97% of Keitaro revenue org-wide (54,844 / 56,338, per migration 0132's verification pass). |
| **Sales** | Group row: `COUNT(*)` of attributed rows with `converted_at IS NOT NULL`. Footer: per stage `GREATEST(Σ keitaro_stage_results.sales, Σ stage_manual_sales.delta)` — a larger denominator than Keitaro sales alone, since hand-entered manual sales carry no recipient to attribute. Per-recipient covers ~90% of that footer basis org-wide (815 attributable vs 908 campaign-grain, 89.8%) — quoted against `GREATEST(...)`, not against Keitaro sales alone (which reads ~96% and understates the gap). |
| **Cost** | Group row: `Σ (campaign_stages.total_cost / that stage's sent-row count)` over attributed rows. **Not** `stage_sends.cost_per_sms` — NULL on 32.7% of rows. Footer: `Σ campaign_stages.total_cost` for non-archived sent stages. |
| **Clicks (EPC denominator)** | Group row: `COUNT(DISTINCT counted_clickers.contact_id)` for clickers who are in the group and whose campaign targeted it (tracked only). Footer/benchmark: offer/org-grain distinct count **plus** manual-stage Keitaro visits. |
| **Opt-outs** | Group row: `COUNT(DISTINCT opt_out_id)` from `opt_out_attributions` joined through `stage_send_id` to a recipient in the group. Footer: campaign-grain distinct count. |
| **RPM** | `revenue / sends * 1000`. 0 sends ⇒ shown as "—". |
| **Net RPM** | `(revenue - cost) / sends * 1000`. |
| **EPC** | `revenue / clicks`. 0 clicks ⇒ "—". |
| **Net profit** | `revenue - cost`. |
| **Opt-out %** | `optouts / sends * 100`. |
| **Sent last 7 / 30 / 90 days** | `COUNT(*)` of attributed `stage_sends` rows within the window — send rows, **not** distinct contacts, scoped to **this offer**, and (since migration 0132) tracked campaigns only. |
| **Fresh pool** | Contacts in the group with no `status='sent'` `stage_sends` row in the last 90 days, across **all** offers and **both** link modes. No opt-out filter. |

## Tracked-only attribution and the per-contact-column limitation

**Group rows only include `link_mode='tracked'` campaigns** (migration 0132).
A manual-mode campaign's economics come from a hand-recorded
`campaign_stages.sms_count`, which has no per-recipient row to join to
`contact_contact_groups` — there is nothing to attribute to a group. Manual
campaigns still contribute to the **offer total and org benchmark** rows
(unchanged since migration 0093 — still tracked + manual). `has_manual_stages`
— the badge flagging a row that mixes deduplicated clicks with raw Keitaro
visit counts — can therefore never be true at group grain any more; it now
lives only on the offer total (`offer_report_offer_totals_mv.has_manual_stages`)
and the org benchmark.

**Sent 7d / 30d / 90d now share the group-row economics' scope exactly**:
tracked campaigns that targeted this group, for this offer. This is a
narrowing from before migration 0132, which counted every in-app send —
tracked or manual, any offer's campaign, whether or not it targeted this
group — as long as the recipient was a group member. **Fresh pool did not
change**: contacts in the group with no `status='sent'` `stage_sends` row in
the last 90 days, across all offers and both link modes, with no opt-out
filter — a rule that happened to overlap with the old Sent 7d/30d/90d
definition and no longer does.

**Every metric on a group row is per-recipient, and group rows do not foot to
the offer footer or org benchmark** — those two use a different, campaign-grain
/ provider-aggregate basis instead (`offer_report_offer_totals_mv` /
`offer_report_org_summary_mv`, sourced from `offer_report_campaign_econ`).
Because a contact can belong to several groups, the same send appears in each
of their group rows, which usually pushes the group columns' sum above the
offer footer (+18.7% on sends, +37.5% on revenue for offer 96 as of
2026-08-13) — but the direction isn't guaranteed: six of 21 offers are 100%
external and render no group rows at all, so their columns sum to 0 against a
non-zero footer, and group opt-outs can fall short of the footer because
`opt_out_attributions.stage_send_id` is nullable. The footer is read at offer
grain from `offer_report_offer_totals_mv`, never summed from the rows. This is
the same dedup-at-display-grain rule migration 0128 applied to clicks,
extended to every column by migration 0132.

**Sends recorded outside the app cannot reach a group row.** ~4.9% of sends have
no per-recipient row (an operator hand-recorded `campaign_stages.sms_count`).
They appear in the footer and are called out beneath the table. Six of 21 offers
are 100% external and render no group rows at all.

## Data layer (migrations 0093, 0126, 0128, 0132)

No Postgres stored functions exist in this app — the convention is
`db.execute(sql\`…\`)` from a `lib/reporting/*.ts` helper. Because the
list-pressure/fresh-pool joins (`stage_sends` ⋈ `contact_contact_groups`, both
large tables) are too heavy to run per page load, v1 precomputes into
**materialized views**, refreshed by cron; reads are then trivial index
lookups.

- **`offer_report_campaign_econ`** (plain view) — per-campaign economics
  (tracked + manual alike); the sole source of **sends, revenue, sales, cost,
  and optouts** on the offer total and org benchmark rows. Clicks on those
  rows come from `counted_clickers`/`keitaro_stage_results` directly, and the
  offer total's `attributable_*` columns come from `stage_sends` directly —
  neither routes through this view.
- **`offer_report_tracked_campaigns`** (plain view, migration 0132) — the
  group-row attribution universe: campaigns with an offer, `link_mode='tracked'`,
  and ≥1 sent stage. `offer_group_report_mv` and `offer_report_offer_totals_mv`
  both select from it so their campaign sets cannot drift apart.
- **`offer_group_report_mv`** (materialized, unique on `(org_id, offer_id, group_id)`)
  — per org×offer×group rollup, built **directly per-recipient** (migration
  0132) from `stage_sends` joined to `contact_contact_groups`, restricted to
  `offer_report_tracked_campaigns` — no longer derived from
  `offer_report_campaign_econ`/`unnest(group_ids)`.
- **`offer_report_offer_totals_mv`** (materialized, unique on `(org_id, offer_id)`,
  migration 0132) — the offer-grain footer, read directly rather than summed
  from `offer_group_report_mv`'s rows. Carries `attributable_sends` /
  `attributable_revenue` / `attributable_sales` (the group rows' per-recipient
  basis, deduplicated at offer grain) and `unattributed_sends`.
- **`offer_report_org_summary_mv`** (materialized, unique on `org_id`) — the
  de-duplicated org-wide benchmark row. Unchanged by migration 0132.
- **`report_refresh_log`** — `(view_name, refreshed_at)`, one row per matview,
  read for the page's "data as of" line.
- Supporting indexes: `stage_sends (sent_at, contact_id)`,
  `contact_contact_groups (contact_group_id, contact_id)`.

Full column lists and the no-RLS note are in
[03-data-model.md](../03-data-model.md#reporting-migration-0093).

`lib/reporting/offer-group-report.ts` exposes two functions:
- `getOfferGroupReport(orgId, offerId)` — reads all **three** matviews
  (org-scoped) and the refresh log, shapes the result into
  `{ rows, offerTotals, orgBenchmark, benchmarkHasManual, refreshedAt }`.
  `offerTotals` comes from `offer_report_offer_totals_mv`, not from summing
  `rows` — a separate matview because an offer whose sends were all recorded
  outside the app has zero group rows and still needs a footer.
- `refreshOfferGroupReport()` — runs `REFRESH MATERIALIZED VIEW CONCURRENTLY`
  on all three matviews (separate statements — `CONCURRENTLY` cannot run
  inside an explicit transaction), `offer_report_offer_totals_mv` **last** —
  not for footer freshness, but for deploy-order blast radius: this code and
  migration 0132 are meant to deploy together (migration first, per
  [CLAUDE.md](../../CLAUDE.md) §14), but if this code ever ships before 0132
  applies, the `offer_report_offer_totals_mv` refresh is the statement that
  throws (relation does not exist). With it last, the two pre-existing
  matviews (`offer_report_org_summary_mv`, `offer_group_report_mv`) still
  refresh and stay live before the throw ends the invocation — refreshing it
  first would freeze all three reports at their last snapshot (twice-daily
  cron, so potentially days) instead of just one. One side effect: the skew
  now runs the other way — the footer can be a few seconds *newer* than the
  group rows beside it, not older — an accepted consequence of the ordering,
  not a defect to "fix" back. Each matview's `report_refresh_log` row is
  stamped with `now()` immediately after that matview's own refresh succeeds
  (not once at the end after all three), so a mid-sequence throw leaves only
  the not-yet-refreshed matviews' rows unstamped.

## Refresh (twice-daily cron)

`GET/POST /api/cron/refresh-offer-group-report`
([app/api/cron/refresh-offer-group-report/route.ts](../../app/api/cron/refresh-offer-group-report/route.ts)),
schedule **`0 5,20 * * *`** (registered in `vercel.json`), `CRON_SECRET`-gated
(`Authorization: Bearer` or `x-cron-secret` header, same pattern as the other
crons — see [crons.md](crons.md)), `export const maxDuration = 300`.

The 300s budget (not 60s) reflects measurement: the full `CONCURRENTLY` refresh
of all three matviews ran ~50s worst-case (cold) / ~37s warm against production
data pre-migration-0132 — a 60s ceiling left no cold-start headroom. Post-0132,
measured 2026-08-13: `offer_report_offer_totals_mv` ~4.5s,
`offer_report_org_summary_mv` ~11s, `offer_group_report_mv` ~25s — ~40.5s
total against the 300s ceiling. This is a background job with no user waiting
on it, so the larger budget costs nothing.

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
- Calls `getOfferGroupReport(orgId, offerId)`, which reads `offerTotals` from
  `offer_report_offer_totals_mv` (migration 0132) — **not** summed from the
  visible group rows. Summing them was the pre-0132 defect: on offer 96 it
  read 904,926 sends against a true 88,536, because a campaign targeting 12
  groups contributed its whole count to each one.
- Computes `breakEvenPer1k = offerTotals.cost / offerTotals.sends * 1000`
  (null at 0 sends).
- Returns `{ offerName, rows, offerTotals, orgBenchmark, benchmarkHasManual,
  breakEvenPer1k, unattributedSends, refreshedAt }`. `unattributedSends` is
  `offerTotals.unattributed_sends` — sends the footer counts that cannot reach
  any group row. Read-only — no writes, no on-demand refresh trigger.

## UI

[app/(protected)/offers/[id]/report/page.tsx](../../app/(protected)/offers/[id]/report/page.tsx)
— a lightweight custom sortable table (not the `DataTable` wrapper, which can't
pin rows or foot a table; justified by the small per-offer row count).

- **Columns:** Group · Sends · RPM · Net RPM · EPC · Sales · Opt-out % · Net
  profit · Sent 7d · Sent 30d · Sent 90d · Fresh pool. Default sort: Net RPM
  descending. All columns sortable client-side (the full row set is already
  loaded).
- **Pinned top row** — "All offers (org-wide)": the de-duplicated
  `orgBenchmark`; the per-contact-window/fresh-pool cells show "—". Carries the
  `+manual` badge when `benchmarkHasManual` is true.
- **Pinned bottom row** — "This offer · all groups": `offerTotals`, read from
  `offer_report_offer_totals_mv` (migration 0132) — **not** footed from the
  visible group rows (see API above). Carries the `+manual` badge when
  `offerTotals.has_manual_stages` is true; group rows never carry it, since a
  manual-mode campaign can't reach a group row at all (see "Tracked-only
  attribution" above).
- **Color coding:** Net RPM ≥ break-even → green, below → red (break-even is
  the blended `cost/1k`, not hard-coded); a `null` break-even (0 total sends)
  renders with no color. Opt-out %: ≤2% green, 2–3% amber, >3% red.
- **Header:** offer name, "data as of {formatCampaignDateTime(refreshedAt)}", a
  Refresh button (re-fetches the current matview snapshot — does **not**
  rebuild it), a CSV export button (client-side, small dataset).
- **Footnotes (three, neither a bug):** (1) when `unattributedSends > 0`, a
  note beneath the table states the count and % of sends that could not be
  attributed to any group (recorded outside the app, or from a
  non-tracked/untargeted campaign) — they sit in the offer total but in no
  group row; (2) when the offer has group rows and revenue and/or sales, a
  coverage note states what % of the footer's revenue/sales the group rows'
  per-recipient basis reaches (`attributable_revenue` / `attributable_sales`
  on `offer_report_offer_totals_mv`, migration 0132) and whether that reads
  low, high, or matches exactly — derived from the actual percentage, not
  assumed, since the two bases aren't a whole-and-part pair and a figure above
  100% is representable; (3) a closing note explaining group rows are counted
  per recipient while the offer footer and org benchmark use a campaign-grain
  basis instead, so the count and money columns do not add up to the offer
  total — a contact in several groups is one send on the offer row and one
  send in each of their groups.

## Files involved

- `db/migrations/0093_offer_group_report.sql` — the original view, two
  matviews, `report_refresh_log`, and the two supporting indexes.
- `db/migrations/0126_offer_report_counted_clickers.sql`,
  `db/migrations/0128_offer_report_dedup_at_grain.sql` — pointed `clicks` at
  the unified `counted_clickers` denominator and fixed its aggregation to
  dedup at each display grain (offer/org, not summed from campaign rows).
- `db/migrations/0132_offer_report_per_recipient_attribution.sql` — per-recipient
  group-row attribution; adds `offer_report_tracked_campaigns` and
  `offer_report_offer_totals_mv`; extends the dedup-at-grain rule to every
  group-row column.
- `lib/reporting/offer-group-report.ts` — read + refresh helper.
- `app/api/offers/[id]/report/route.ts` — the API route.
- `app/api/cron/refresh-offer-group-report/route.ts` — the twice-daily refresh cron.
- `app/(protected)/offers/[id]/report/page.tsx` — the report page.
- `app/(protected)/offers/page.tsx` — the "Group Report" entry-point link.
- `vercel.json` — cron registration.
- `scripts/verify-offer-group-attribution.ts` — the only gate on this work;
  recomputes both sides of every check against the live database (no numbers
  transcribed from a spec) and asserts the footer/group-row/residual
  identities migration 0132 depends on.
- `scripts/test-offer-group-report-helper.ts` — smoke-tests
  `getOfferGroupReport`/`refreshOfferGroupReport` directly against a real org
  and offer, independent of the API route and the UI.
