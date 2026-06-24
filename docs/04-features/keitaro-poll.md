# Feature — Keitaro Results Poll

_Last updated: 2026-06-24_

## 1. Purpose
Pull live click + conversion + revenue data from the **Keitaro** tracker every 5
minutes and store it per campaign/stage so the CRM shows real-time campaign
performance — without manual CSV imports. Code lives in [`lib/keitaro/`](../../lib/keitaro/).

## 2. How CamMan maps to Keitaro (the key fact)
CamMan's tracked links put the **stage tracking id** (e.g. `5_14296_051526_1_s2_c42`,
see CLAUDE.md §10g) into the offer's postfix URL param, which is configured as
`sub_id_3` in Keitaro. So:

- `sub_id_3` = **stage** tracking id (NOT a bare campaign id; the campaign tracking
  id `5_14296_051526_1` is its prefix).
- Grouping the Keitaro report by `sub_id_3` yields **per-stage** rows. A campaign's
  totals are the **SUM across its stages**.
- Mapping back to CamMan needs no extra "keitaro id" column — match `sub_id_3`
  against `campaign_stages.tracking_id`.

> The `GET /admin_api/v1/campaigns` call (id/alias/name) maps each report row's
> Keitaro campaign → its **alias** for the visit/redirect classification (§2b). It
> is still **not** the join key — that remains `sub_id_3`.

## 2a. Auto-fill of the stage Results panel (migration 0077)
After each poll upserts `keitaro_stage_results`, it syncs the stage's auto-owned
counters for every stage touched this run (summed across all `stat_date`s):
`campaign_stages.click_count` ← `visit_clicks_clean` ("Clickers"),
`checkout_click_count` ← `checkouts`. The poll also stamps
`keitaro_stage_results.payout_at_conversion` (= `revenue / NULLIF(sales,0)`,
migration 0083) so each row freezes the per-conversion rate that was actually paid
— immune to a later CPA edit on the offer. `sales_payout_each` is still snapshotted
from the campaign's offer CPA when conversions appear (COALESCE keeps an existing
snapshot), but it is now only the manual-results form's pre-save **estimate** — the
revenue source of truth is `keitaro_stage_results.revenue`, never `sales × CPA`.
**Per-field positive-only guard:** each
counter is overwritten ONLY when Keitaro reports a value `> 0` — a Keitaro 0 never
zeroes an existing number. Keitaro sums are monotonic, so this never drops an
update. Stages with no Keitaro rows are left untouched.

**Sales = max(manual, Keitaro), NOT the sum (changed 2026-06-21).** `campaign_stages.sales_count`
holds the operator's **manual** sale tally; the poll does **not** touch it. At read
time Sales = **`max(manual_tally, Keitaro_conversions)`** per stage — the **larger**
of the two, via [`combineSales()`](../../lib/stage-results.ts). A sale that's both
Keitaro-tracked **and** manually tallied is the *same* sale, so the previous
**additive** (`manual + Keitaro`) double-counted it — e.g. Keitaro 1 + manual 1 = 2
for one real sale. Taking the max dedupes that overlap (assuming the smaller set ⊆
the larger) while preserving whichever source saw more: Keitaro when it's ahead, and
the manual baseline on stages where Keitaro **under-counts** (incomplete `sub_id`
capture, see the operational note below). This is how the **stages API** reports it —
`keitaro_sales_count` per stage ([app/api/campaigns/[campaignId]/stages/route.ts](../../app/api/campaigns/[campaignId]/stages/route.ts),
a correlated `sum(keitaro_stage_results.sales)`); the campaign-detail page combines
the two with `combineSales`, and Revenue/ROI rate the **combined** count ×
`sales_payout_each`. (History: the poll once OVERWROTE `sales_count` ← Keitaro `sales`
— clobbered manual entries, gone; then it was made additive 2026-06-19 — double-counted
overlapping sales, replaced by max 2026-06-21.)

> **`/reports` anchors the manual baseline to the stage's send date (changed 2026-06-20).**
> Reports is a **date-ranged** view, but manual sends/sales carry no per-event
> timeline — `sales_count` and `sms_count` are single overwrite-on-save integers.
> So under activity-date scoping they ride the stage's one send moment: a stage's
> full lifetime manual `sales_count` is combined (via `max`, not sum) with the
> in-range Keitaro conversions **only when `campaign_stages.sent_at` falls in the
> window** — out of range the manual tally drops out and only Keitaro counts. **Total Sent**
> for a manual-send campaign (`link_mode='manual'`) is `sms_count` gated the same
> way. Tracked campaigns (`link_mode='tracked'`) keep the per-recipient
> `stage_sends` count for Total Sent. (Earlier the report dated manual sales by a
> `stage_manual_sales` ledger entry time; the migration-0079 backfill stamped every
> pre-existing total at `now()`, so any window covering the backfill date showed
> the full lifetime — that's why it looked like the date filter was ignored. The
> ledger table still records deltas for audit/current-total but no longer drives
> the report.) The stage Results panel and campaign-detail column are NOT
> date-ranged and show the full lifetime `max(manual, Keitaro)`. See §5/§5b.

Combined with the opt-out poller mirroring `inbound_opt_out_count` → `opt_out_count`,
the per-stage Results panel (SMS sent · Delivered · **Opt-outs** · **Clickers** ·
Scrubbed · Bounced · **Checkout Clicks** · **Sales** · Total Cost) reflects Keitaro
+ TextHub automatically; SMS/Delivered/Scrubbed/Bounced/Total Cost + the manual
sales baseline remain operator-owned. The campaigns detail page's compact per-stage
**Results** column surfaces `Clicks · Checkout · Sales · CTR · OptOut` (Sales =
full lifetime `max(manual, Keitaro)`). `/reports` shows Sales per stage and per
campaign too, but date-ranged it is **`max(Keitaro conversions in range, the
stage's manual sales)`, with the manual side counted only when its `sent_at` lands
in the period** (see the note above).

> **Operational reality (2026-06-19): the network fires only `lead` postbacks.**
> A direct Keitaro probe over Jun 1–19 returned 11 conversions, **all status
> `lead`** ($668 revenue), and **zero `sale`** of any kind (checked with no status
> filter — no hidden `deposit`/`approved` rows). So Keitaro's bare `sales` metric is
> always 0; the payable events are the **`conversions`** (= leads + sales), which we
> map into Sales. Keitaro's conversion tracking is also **incomplete** — only ~1–4
> of the 11 even carried `sub_id_1` — so it captures far fewer than the operator's
> manual tally (~104). That under-count is why Sales takes **`max(manual, Keitaro)`**
> rather than letting Keitaro overwrite: the manual baseline survives where Keitaro
> can't see, but Keitaro is used where it's ahead. (It used to **sum** the two —
> changed 2026-06-21 because that double-counted sales present in both sources.)
> Mapping: `leads`→checkout, **`conversions`→sales**, `revenue`→revenue (real per-conversion).

## 2b. Visit vs Offer Redirect classification (Step 5b)
Two kinds of Keitaro campaign fire clicks for the **same** `sub_id_3` (stage):

- The **visit** campaign — Keitaro **name `gk-lp-visits`** — fires when a visitor
  LANDS on the landing page. Its clean clicks are **Clickers**.
- **Offer** campaigns (one per offer, e.g. `Kinzeno - 14508`) fire when a visitor
  clicks through to the offer. Their clean clicks are **Offer Redirect**, and
  their conversions are **Sales**.

Classify by the campaign **name** (`gk-lp-visits`), never a numeric id — the name
is the rebuild-safe human label. **Match on `name`, not `alias`:** in the live
panel `gk-lp-visits` is the campaign's *name*; its *alias* is a random code (e.g.
`ZttBSV`), so matching on alias finds nothing (this was a real bug — fixed
2026-06-15). The classifier (`buildVisitClassifier` in `poll.ts`) resolves the
visit name → its `campaign_id`(s) **once** from the campaigns list, then classifies
each row by the reliable `campaign_id` the report returns (row `campaign` name as
fallback). The poll response reports `visit_campaigns_matched` (expect 1). If the
campaigns list fails to load, every row falls back to the redirect side (the safe
default) and `classification_degraded: true` is set — the next cycle self-heals
once the list loads.

**Funnel semantics — visits ⊇ redirects, never summed:** every offer redirect is
also a visit, so total arrivals = the visit (Clickers) count. The headline number
for each stage is the **clean** (bot/prefetch-filtered) count.

## 3. The poll (`lib/keitaro/poll.ts` → `pollKeitaro`)
1. Build the request window: a rolling **3-day** lookback in ET
   (`?windowDays=N` overrides, capped 30). Late conversions arrive minutes-to-hours
   after the click, so a multi-day window re-attaches them to earlier days.
2. `POST {KEITARO_API_URL}/admin_api/v1/report/build` with
   `range:{from,to,timezone:"America/New_York"}`,
   `grouping:["day","sub_id_3","campaign_id"]`, `metrics` (both centralized in
   `lib/keitaro/client.ts`). The **campaign** dimension is what separates visits
   from redirects (§2b).
3. Resolve every distinct `sub_id_3` → stage/campaign/org in one query, and load
   the campaigns list for the alias classifier (in parallel).
4. **Fold** the per-campaign rows into one aggregate per (stage, ET date),
   routing each row's clicks to the visit or redirect side by alias; conversions
   only ever attach to the redirect (offer) side.
5. Idempotent **UPSERT** per (stage, date) into `keitaro_stage_results`
   (`onConflictDoUpdate` on `(org_id, stage_id, stat_date)`, `synced_at = now()`).
   Each poll recomputes the **full** window totals and overwrites in place —
   never appends, never double-counts. (The fold is required: multiple campaign
   rows now share one `(stage, date)` key, so a per-row last-write-wins would drop
   all but the last campaign.)

**Metric mapping (Keitaro → CamMan term → column):**

| Keitaro key | CamMan term | Column |
|-------------|-------------|--------|
| `clicks` (visit campaign) | Raw visit clicks | `visit_clicks_raw` |
| `campaign_unique_clicks` (visit campaign) | **Clickers** | `visit_clicks_clean` |
| `clicks` (offer campaigns) | Raw offer clicks | `redirect_clicks_raw` |
| `campaign_unique_clicks` (offer campaigns) | **Offer Redirect** | `redirect_clicks_clean` |
| `leads` (offer) | Checkouts (CI) | `checkouts` |
| `sales` (offer) | Sales (CV) | `sales` |
| `revenue` (offer) | Revenue | `revenue` |
| `cost` (offer) | Cost | `cost` |
| `epc` | EPC (derived rev/redirect-raw) | `epc` |

The poll also mirrors the redirect totals into the legacy `raw_clicks` /
`clean_clicks` columns so the pre-5b column meaning (offer clicks) stays
consistent. Derived rates (Redirect %, Sales CR, EPC, Profit) are computed at read
time in [`lib/keitaro/funnel.ts`](../../lib/keitaro/funnel.ts), not stored.

## 4. Storage (`keitaro_stage_results`, migrations 0061 + 0062)
One row per (org, stage, ET date). `UNIQUE(org_id, stage_id, stat_date)`. RLS:
org-scoped SELECT; writes go through the app's privileged cron connection (no
authenticated write policy — mirrors `campaign_events`). Migration **0062** adds
the four split columns (`visit_clicks_raw/clean`, `redirect_clicks_raw/clean`).
**Legacy fallback:** pre-5b rows have all four split columns at 0 but may carry
offer-redirect counts in the legacy `raw_clicks` / `clean_clicks`; the read layer
(`funnel.ts`) treats those as the redirect side, visits unknown (0). See
[03-data-model.md](../03-data-model.md).

## 5. Endpoints
- `GET|POST /api/keitaro/poll` — cron (CRON_SECRET) or manual (operator+,
  `result_imports.create`). `?windowDays=N`. Returns
  `{ ok, degraded, range, fetched, matched, upserted, unmatched, errored, classification_degraded, visit_campaigns_matched, unmatched_samples, error }`.
- `GET /api/keitaro/results?campaign_id=<id>` — read-only; org-scoped. Per-(stage,
  date) rows plus per-stage and campaign rollups with the Clickers → Offer
  Redirect → Sales funnel + derived rates. Requires `campaigns.view`.
- `GET /api/keitaro/reports?from&to&search&groupBy&page&pageSize&sortBy&sortDir` —
  read-only; org-scoped. Cross-campaign funnel aggregated over an ET date
  range (≤92 days, default last 7), with resolved campaign + stage names, grand
  totals, and pagination/sort. Powers the **Reports** page (`/reports`). Requires
  `campaigns.view`. Never triggers a poll. **Every metric is scoped to the
  selected ET date range** — there are no lifetime counters leaking into a
  date-ranged view (fixed 2026-06-20). Concretely:
  - `opt_outs` = count of `opt_out_attributions` credited to the stage whose
    `created_at` falls in `[from 00:00 ET, day-after-`to` 00:00 ET)` (the credit
    time ≈ STOP receipt; poller lag ≤15min). **Not** the lifetime
    `campaign_stages.inbound_opt_out_count`.
  - `total_sent` — **tracked** campaigns (`link_mode='tracked'`): count of
    `stage_sends` with `status='sent'` (failed/rejected/pending/filtered excluded)
    and `sent_at` in range. **Manual** campaigns (`link_mode='manual'`, the common
    case): the stage's lifetime `sms_count`, counted only when `campaign_stages.sent_at`
    lands in range. The two sources are mutually exclusive (manual sends have no
    `stage_sends` rows), so no double-counting.
  - `opt_out_rate` = `opt_outs / total_sent` (a fraction, 0 when nothing was
    sent), rendered as a %.
  - `click_rate` (CR) = `clickers / total_sent` (a fraction, 0 when nothing was
    sent), rendered as a %. Shares the `rateOfSent` helper with `opt_out_rate`.
  - Clickers/Offer Redirect/Revenue are the Keitaro funnel, bounded by
    `stat_date`. **Cost** is the stage's auto-calculated SMS spend
    (`campaign_stages.total_cost` = `cost_per_sms × (sends + opt_outs)`, see
    [`lib/stages/total-cost.ts`](../../lib/stages/total-cost.ts)) — **not**
    `keitaro_stage_results.cost` (Keitaro ad-platform spend, always 0 here). Like
    manual sends/sales it has no per-day timeline, so the whole lifetime value is
    attributed to the stage's `sent_at` and counted only when that lands in range
    (0 otherwise, keeping it consistent with the row's 0 sends). `Profit` =
    `Revenue − Cost` follows automatically. **Sales** = `max(Keitaro conversions in range, the stage's manual
    `sales_count`)`, with the manual side counted only when its `sent_at` lands in
    range (manual sends/sales have no per-event timeline, so they ride the send
    activity's date — see §2a). The `max` (not a sum) dedupes a sale present in both
    Keitaro and the manual tally — see §2a. Manual revenue is not added (report
    Revenue stays Keitaro-only, as before).

  Opt-outs/total-sent are computed by two grouped queries over the stages in view.
  All are in the grand totals and sortable. The exclusive upper bound is built off
  the next calendar day (not +24h) so it stays correct across DST.
  **`groupBy=stage` (default) or `campaign`:** campaign rollups fold every stage of
  a campaign into one funnel row (clickers/redirect/**sales**/revenue/cost/**total_sent**/
  opt-outs summed across the campaign's stages, rates — including `opt_out_rate` —
  re-derived), and carry `stage_count` instead of stage fields. Lets you read
  **sales per campaign** as well as per stage. Grand totals are unchanged by grouping.

## 5b. Reports UI (`/reports`)
A dedicated cross-campaign page ([`app/(protected)/reports/page.tsx`](../../app/(protected)/reports/page.tsx))
showing the funnel: Campaign · Stage · **Total Sent** (per-recipient `stage_sends`
in range for tracked campaigns; the stage's `sms_count` for manual campaigns when
`sent_at` is in range) · **Opt-outs** (STOPs credited to the stage in range) ·
**OptOut, %** (opt-outs ÷ total sent) · **Clickers** · **CR, %** (clickers ÷ total
sent) · **Offer Redirect** · Redirect % · Sales · Sales CR · Revenue · Cost · EPC · Profit,
with a date-range filter, search, sortable columns, grand-total stat cards
(Clickers · Offer Redirect · Sales · Revenue · Cost · Profit · **Avg Opt-out** —
the period's aggregate opt-out rate, grand opt-outs ÷ grand total sent), and a
manual **Refresh from Keitaro** button (operator+, runs the poll). A **Group by**
toggle (Stage / Campaign) switches between per-stage rows and per-campaign rollups
(the Stage column becomes a `Stages` count) so **sales (and the whole funnel) can
be read per campaign**. Nav entry under
**Campaigns** (always enabled — Reports is a feature, not a flagged entity).
The **Campaign** cell links to `/campaigns/[id]`; the **Stage** cell links to
`/campaigns/[id]?stage=[stageId]`, which the campaign detail page consumes on load
to auto-open that stage's editor (there is no standalone stage route).

## 6. Fail-safe behavior
- A failed report fetch returns `200 { degraded:true, error }` — the cron logs and
  retries next cycle instead of crashing or partial-writing.
- Each row's UPSERT is isolated (try/catch); one bad row is counted (`errored`) and
  skipped, never aborting the batch.
- Unmatched / blank `sub_id_3` rows are counted and a few sampled in the response so
  you can see exactly what Keitaro is sending if nothing maps back.
- `KEITARO_API_KEY` unset ⇒ `degraded:true`, no writes.

## 7. Scope & follow-ups
- **In scope:** the aggregate layer — per-stage/campaign/day clicks, conversions,
  revenue, EPC — **split into Clickers (visits) vs Offer Redirect (offer clicks)**
  (Step 5b), surfaced on the `/reports` page. **Plus** the per-recipient SALE
  attribution layer (§9 below).
- **Metric-key verification:** keys come from the documented Keitaro schema and are
  centralized in `KEITARO_METRICS`. Confirm against the live Swagger/DevTools on the
  first real run (a wrong key silently returns nothing); fix in one place.
- **Security:** rotate the Admin API key shared in plaintext during setup.

## 8. Per-recipient SALE attribution (conversions poll)
A second, independent poll maps individual Keitaro **sales** back to the **phone
number** that received the SMS. Code: [`lib/keitaro/poll-conversions.ts`](../../lib/keitaro/poll-conversions.ts),
client `fetchKeitaroConversions` in [`lib/keitaro/client.ts`](../../lib/keitaro/client.ts).

**The id chain.** The per-recipient customer id is `stage_sends.id` (= the link's
`send_token`). At **redirect time** ([`lib/links/resolve-click.ts`](../../lib/links/resolve-click.ts))
the `/r/<code>` handler appends `&sub_id1=<send_token>` to the shared per-stage
destination — the operator's stage **Full URL is never touched**, and the single
`link_destinations` row stays shared. So a recipient's browser reaches Keitaro
carrying both `sub_id3` (stage id) and `sub_id1` (recipient id). A conversion's
`sub_id_1` then maps 1:1 back to the `stage_sends` row → the phone.

**Spelling split (mirrors `sub_id3`):** the inbound URL param is **`sub_id1`**
(no underscore); the Keitaro token / report column is **`sub_id_1`** (underscore).
The campaign's *Parameters* tab maps one to the other. Don't confuse them.

**The poll** (`*/15` cron, `GET|POST /api/keitaro/poll-conversions`):
1. `POST {KEITARO_API_URL}/admin_api/v1/conversions/log` with `{range, columns,
   filters}` — a **rolling 7-day** ET window (sales lag clicks). One row per
   conversion, columns `event_id, sub_id_1, status, revenue, datetime,
   click_datetime`. **Confirmed live against the `events` report schema:**
   `revenue` is the revenue column (not `payout`); `event_id` (UUIDv7) is the
   unique conversion id; the endpoint **rejects an `order` key** and returns
   **only** requested columns (400s on any unknown column).
2. Fold to the **latest** conversion per `sub_id_1` (sorted by `datetime` in
   memory — no server-side order), keeping only `status ∈ (lead,sale,rejected)`.
3. Resolve which `sub_id_1` exist as `stage_sends.id` in one query (with their
   current `keitaro_conversion_id`), then `UPDATE` each row's `sale_status` /
   `sale_revenue` / `converted_at` / `keitaro_conversion_id`.
   - **Dedup on `event_id`:** a row already carrying the latest event's id is
     skipped. Combined with latest-wins-per-recipient, re-runs are idempotent.
   - **Timezone:** Keitaro `datetime` is ET wall-clock; stored as the correct UTC
     instant via a zoned literal cast (a bare `::timestamp` lets postgres-js infer
     timestamptz and pre-shifts it — see [07-conventions.md](../07-conventions.md)).
   - Returns `{ ok, degraded, range, fetched, recipients, matched, updated,
     deduped, unmatched, errored, unmatched_samples, sample }`. `sample` is a few
     raw rows for debugging what Keitaro sends.

**Model — one sale per recipient, latest wins.** `sale_revenue` is the latest
conversion's revenue, **not** a cumulative sum across repeat sales. Upgrade path
for cumulative/repeat-sale tracking: a separate append-only `keitaro_conversions`
ledger keyed on `event_id`, with these columns becoming a derived rollup — **not
built**.

**Tracked sends only.** Manual-mode rows mint no link and reach no redirect, so
they never carry `sub_id1`; their sale columns stay NULL (expected).

**UI:** a **Sale** badge column on the Activity → Messages per-recipient list
([`components/campaigns/campaign-activity-section.tsx`](../../components/campaigns/campaign-activity-section.tsx)):
`sale` = green (+revenue), `lead` = amber, `rejected` = muted red, none = `—`.

## 8b. Per-recipient OFFER-PAGE REACH (offer-reach poll — engagement Level 2)
A third independent poll maps individual Keitaro **offer-page clicks** back to the
recipient, so segments can express "reached the offer page" (Level 2). Code:
[`lib/keitaro/poll-offer-reaches.ts`](../../lib/keitaro/poll-offer-reaches.ts),
client `fetchKeitaroClicks` in [`lib/keitaro/client.ts`](../../lib/keitaro/client.ts).

**The id chain is identical to sales** — the same `sub_id1`/`sub_id_1` recipient id
(`stage_sends.id`) injected at redirect time. The difference is the SOURCE: clicks
(`clicks/log`), not conversions. **Confirmed live:** an offer-campaign click (e.g.
`Kinzeno - 14508 - Default`) carries the same `sub_id_1` as the recipient's
landing-page (`gk-lp-visits`) click — so the offer reach is per-recipient.

**The poll** (`*/15` cron, `GET|POST /api/keitaro/poll-offer-reaches`):
1. `POST {KEITARO_API_URL}/admin_api/v1/clicks/log` with columns `event_id,
   sub_id_1, campaign, campaign_id, datetime`, **rolling 7-day** ET window, filtered
   server-side to `sub_id_1 NOT_EQUAL ""`. One row per click.
2. **Drop landing clicks** (`campaign` name = `gk-lp-visits`, case-insensitive) —
   those are Level 1. Keep OFFER-campaign clicks (Level 2). Same campaign-name
   classifier the aggregate poll uses; `clicks/log` returns the name directly, so
   no campaigns-list join is needed.
3. Fold to the **earliest** offer click per `sub_id_1`, resolve which exist as
   `stage_sends.id`, then `UPDATE` `offer_reached_at` + `offer_reach_event_id`.
   - **Reach is monotonic:** a row already carrying an `offer_reach_event_id` is
     skipped (no status progression, unlike sales). `WHERE offer_reached_at IS NULL`
     guards the write.
   - **Timezone:** the **same** ET-wall-clock → UTC zoned-literal cast reused from
     the sale poll (`(${dt} || ' ' || ${CAMPAIGN_TIMEZONE})::timestamptz`).
   - Returns `{ ok, degraded, range, fetched, landing_skipped, recipients, matched,
     updated, deduped, unmatched, errored, unmatched_samples, sample }`.

**Tracked sends only** (same as sales): manual-mode rows never carry `sub_id1`, so
`offer_reached_at` stays NULL. **Reliability caveat:** attribution depends on the
landing page forwarding `sub_id1` into its outbound offer link; a click that loses
it is simply not attributed (silent under-count, never wrong attribution) — validate
the propagation rate once real send volume exists.

**Segment rule:** `reached_offer` / `_for_brand` / `_for_offer` read
`offer_reached_at IS NOT NULL` (see [audience-segments.md](audience-segments.md)).
"Reached but didn't buy" = `reached_offer` is + `made_purchase` is_not.

## 9. Verification (with the live `kinzeno` test data)
1. Set `KEITARO_API_KEY`, hit `POST /api/keitaro/poll` manually (operator+).
2. `GET /api/keitaro/results?campaign_id=<kinzeno campaign>` shows Raw/Clean Clicks ≥
   the fired clicks and the test Sale + revenue.
3. Re-run the poll → totals update in place, not duplicated (idempotency).
4. A campaign with no activity returns zeros, not an error.
   If nothing maps, inspect `unmatched_samples` to see the actual `sub_id_3` values.
