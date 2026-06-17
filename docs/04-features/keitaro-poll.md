# Feature — Keitaro Results Poll

_Last updated: 2026-06-17_

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
- `GET /api/keitaro/reports?from&to&search&page&pageSize&sortBy&sortDir` —
  read-only; org-scoped. Cross-campaign per-stage funnel aggregated over an ET date
  range (≤92 days, default last 7), with resolved campaign + stage names, grand
  totals, and pagination/sort. Powers the **Reports** page (`/reports`). Requires
  `campaigns.view`. Never triggers a poll.

## 5b. Reports UI (`/reports`)
A dedicated cross-campaign page ([`app/(protected)/reports/page.tsx`](../../app/(protected)/reports/page.tsx))
showing the funnel per stage: Campaign · Stage · **Clickers** · **Offer Redirect**
· Redirect % · Sales · Sales CR · Revenue · Cost · EPC · Profit, with a date-range
filter, search, sortable columns, grand-total stat cards, and a manual
**Refresh from Keitaro** button (operator+, runs the poll). Nav entry under
**Campaigns** (always enabled — Reports is a feature, not a flagged entity).

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

## 9. Verification (with the live `kinzeno` test data)
1. Set `KEITARO_API_KEY`, hit `POST /api/keitaro/poll` manually (operator+).
2. `GET /api/keitaro/results?campaign_id=<kinzeno campaign>` shows Raw/Clean Clicks ≥
   the fired clicks and the test Sale + revenue.
3. Re-run the poll → totals update in place, not duplicated (idempotency).
4. A campaign with no activity returns zeros, not an error.
   If nothing maps, inspect `unmatched_samples` to see the actual `sub_id_3` values.
