# Feature — Keitaro Results Poll

_Last updated: 2026-06-15_

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

- The **visit** campaign — alias **`gk-lp-visits`** — fires when a visitor LANDS
  on the landing page. Its clean clicks are **Clickers**.
- **Offer** campaigns (one per offer, e.g. `Kinzeno - 14508`) fire when a visitor
  clicks through to the offer. Their clean clicks are **Offer Redirect**, and
  their conversions are **Sales**.

Classify by the campaign **alias** (`gk-lp-visits`), never a numeric id — the
alias is rebuild-safe. The classifier (`buildVisitClassifier` in `poll.ts`)
resolves each row's campaign via the campaigns list (id→alias and name→alias) so
it works whether the report returns `campaign_id` or `campaign`. If the campaigns
list fails to load, every row falls back to the redirect side (the safe default)
and the poll response sets `classification_degraded: true` — the next cycle
self-heals once the list loads.

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
  `{ ok, degraded, range, fetched, matched, upserted, unmatched, errored, classification_degraded, unmatched_samples, error }`.
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
  (Step 5b), surfaced on the `/reports` page.
- **Deferred — per-customer detail layer:** the brief's per-`sub_id_5` (customer)
  rows are NOT built. CamMan currently sends one **shared** destination URL per stage
  and the `/r/<code>` redirect forwards it verbatim, so no per-recipient identifier
  reaches Keitaro (`sub_id_5` is a static UTM value today). Per-customer detail needs
  a separate change that injects a unique `sub_id_5` (e.g. the link code) at redirect
  time. See [tracking-attribution.md](tracking-attribution.md).
- **Metric-key verification:** keys come from the documented Keitaro schema and are
  centralized in `KEITARO_METRICS`. Confirm against the live Swagger/DevTools on the
  first real run (a wrong key silently returns nothing); fix in one place.
- **Security:** rotate the Admin API key shared in plaintext during setup.

## 8. Verification (with the live `kinzeno` test data)
1. Set `KEITARO_API_KEY`, hit `POST /api/keitaro/poll` manually (operator+).
2. `GET /api/keitaro/results?campaign_id=<kinzeno campaign>` shows Raw/Clean Clicks ≥
   the fired clicks and the test Sale + revenue.
3. Re-run the poll → totals update in place, not duplicated (idempotency).
4. A campaign with no activity returns zeros, not an error.
   If nothing maps, inspect `unmatched_samples` to see the actual `sub_id_3` values.
