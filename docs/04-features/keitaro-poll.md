# Feature — Keitaro Results Poll

_Last updated: 2026-06-12_

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

> The `GET /admin_api/v1/campaigns` call (id/alias/name) is only a sanity/debug
> aid (e.g. confirm the `kinzeno` campaign exists); it is **not** the join key.

## 3. The poll (`lib/keitaro/poll.ts` → `pollKeitaro`)
1. Build the request window: a rolling **3-day** lookback in ET
   (`?windowDays=N` overrides, capped 30). Late conversions arrive minutes-to-hours
   after the click, so a multi-day window re-attaches them to earlier days.
2. `POST {KEITARO_API_URL}/admin_api/v1/report/build` with
   `range:{from,to,timezone:"America/New_York"}`, `grouping:["day","sub_id_3"]`,
   `metrics` (centralized in `KEITARO_METRICS`, `lib/keitaro/client.ts`).
3. Resolve every distinct `sub_id_3` → stage/campaign/org in one query.
4. Idempotent **UPSERT** per (stage, date) into `keitaro_stage_results`
   (`onConflictDoUpdate` on `(org_id, stage_id, stat_date)`, `synced_at = now()`).
   Re-polling overwrites in place — never appends, never double-counts.

**Metric mapping (Keitaro → CamMan term → column):**

| Keitaro key | CamMan term | Column |
|-------------|-------------|--------|
| `clicks` | Raw Clicks | `raw_clicks` |
| `campaign_unique_clicks` | Clean Clicks | `clean_clicks` |
| `leads` | Checkouts (CI) | `checkouts` |
| `sales` | Sales (CV) | `sales` |
| `revenue` | Revenue | `revenue` |
| `cost` | Cost | `cost` |
| `epc` | EPC | `epc` |

Derived rates (CTR, Checkout Rate, Sales CR) are computed at read time, not stored.

## 4. Storage (`keitaro_stage_results`, migration 0061)
One row per (org, stage, ET date). `UNIQUE(org_id, stage_id, stat_date)`. RLS:
org-scoped SELECT; writes go through the app's privileged cron connection (no
authenticated write policy — mirrors `campaign_events`). See
[03-data-model.md](../03-data-model.md).

## 5. Endpoints
- `GET|POST /api/keitaro/poll` — cron (CRON_SECRET) or manual (operator+,
  `result_imports.create`). `?windowDays=N`. Returns
  `{ ok, degraded, range, fetched, matched, upserted, unmatched, errored, unmatched_samples, error }`.
- `GET /api/keitaro/results?campaign_id=<id>` — read-only; org-scoped. Returns the
  raw per-(stage, date) rows plus per-stage and campaign rollups with derived rates.
  Requires `campaigns.view`. Never triggers a poll.

## 6. Fail-safe behavior
- A failed report fetch returns `200 { degraded:true, error }` — the cron logs and
  retries next cycle instead of crashing or partial-writing.
- Each row's UPSERT is isolated (try/catch); one bad row is counted (`errored`) and
  skipped, never aborting the batch.
- Unmatched / blank `sub_id_3` rows are counted and a few sampled in the response so
  you can see exactly what Keitaro is sending if nothing maps back.
- `KEITARO_API_KEY` unset ⇒ `degraded:true`, no writes.

## 7. Scope & follow-ups
- **In scope (this step):** the aggregate layer — per-stage/campaign/day clicks,
  conversions, revenue, EPC.
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
