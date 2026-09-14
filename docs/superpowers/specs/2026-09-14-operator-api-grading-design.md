# Operator API — creative-grading additions (design)

_Date: 2026-09-14 · Status: approved by the Owner 2026-09-14 · No migration_

A creative manager grades campaign results daily through the personal-token API
([docs/operator-api.md](../../operator-api.md)). Six additions (plus two
nice-to-haves) give them the metrics that grading needs.

## Constraints (unchanged, non-negotiable)

- Read-only and aggregate-only: no contact rows, no recipient phone numbers, no
  exports, no writes. Sending numbers (`provider_phones.phone_number`) may show,
  as they already do.
- Token access stays an explicit allowlist in `OPERATOR_ROUTE_MAP`
  ([lib/authz/route-map.ts](../../../lib/authz/route-map.ts)); absent = denied.
- Every route resolves `org_id` via `requireApiMembership` and filters by it.
- No migration, no cache table, no cron.

## Recon — measured on prod, 2026-09-14 (last 30 days unless stated)

| Fact | Value | Consequence |
|---|---|---|
| Per-recipient reached (`stage_sends.offer_reached_at`) | 4,557 vs Keitaro clean redirects 4,204 | per-recipient reach is the better count |
| Per-recipient conversions / revenue | 532 / $35,560 vs Keitaro 539 / $35,953 | sources agree to ~1% |
| Clicks | 708,086 raw · 65,154 scored human (9.2%) · 638,756 suspect · 29 unscored | bots ≈ 91% |
| STOPs credited to >1 stage | 0 of 37,621 (attribution credits the most recent stage within 72h) | no cross-stage double count |
| STOP latency | 67% ≤2h · 90% ≤12h · 94% ≤24h · 90.4% same ET day | send-day cohort is near-final by evening |
| Tail conversions (dated after the send day) | 137 of 539 (25%), $9,143 of $35,953, max 34 days | daily grading needs tails |
| Stages whose sends cross ET midnight | 6 of 857 (1% of sends, max 1 day) | stage send day ≈ per-send day (99%) |
| Stages whose links carry a different creative than the stage now | 10 of 1,768 (0.6%, 90d) | key usage on the stage's creative |
| Active campaigns / stages | 53 / 135 (max 6 per campaign, 0 manual) | audit fits one request |
| Human+raw click EVENTS per stage | 4.1s (7d), 13.3s (30d) — full scan of `clicks` | too slow for performance |
| Sends per stage per day | 178 ms (1d), 9.2 s (7d), 12.4 s (30d) | cap opt-out range |
| Audit sent+reached, all active campaigns | 568 ms | cheap |
| Opt-out cohort × contact group, 1 day | 882 ms | acceptable |

## Decisions (Owner, 2026-09-14)

1. **Conversions/revenue source = the tracker** (`keitaro_stage_results`). Per-recipient
   data is used only for `reached`, which has no aggregate.
2. **`clicks_human` = distinct human clickers** from the `counted_clickers` cache —
   the platform's EPC denominator. No click-event counts on performance.
3. **Per-number daily opt rate = send-day cohort.**
4. **Architecture A** — extend existing routes + thin new routes, one shared
   definitions module `lib/reporting/grading.ts`.

## 1. Metric definitions (`lib/reporting/grading.ts`)

| Field | Definition | Source |
|---|---|---|
| `sent` | sends with `status='sent'`; manual-mode stages use `sms_count` (as today) | `stage_sends` |
| `reached` | sends whose `offer_reached_at` is set (first offer click) | `stage_sends` |
| `clicks_human` | distinct recipients with a scored human click OR a conversion (Rule F), deduped at the row's grain; manual stages fall back to Keitaro clean visits (`denominatorFor`) — equal to the existing `counted_clickers` | `counted_clickers` |
| `conversions`, `revenue` | tracker conversions and payout. Performance keeps its existing `sales`/`revenue` (which add the manual ledger; identical with 0 manual campaigns) | `keitaro_stage_results` |
| `opt_outs` | STOPs credited to the row's sends | `opt_out_attributions` |
| `click_to_reach_pct` | `reached ÷ clicks_human × 100`; may exceed 100 (a recipient can reach the offer without a scored-human click); not clamped | derived |
| `reach_to_sale_pct` | `conversions ÷ reached × 100` (performance: `sales ÷ reached`) | derived |
| `opt_rate` | `opt_outs ÷ sent × 100` | derived |

- Percentages are percent units (3.12 = 3.12%), rounded to 2 decimals, `null` when
  the denominator is 0.
- Manual-mode stages have no per-recipient data, so their `reached` is `null`
  and contributes nothing to a sum. A row is `null` for `reached`,
  `click_to_reach_pct` and `reach_to_sale_pct` only when ALL its stages are
  manual — `null` never reads as a real zero. (Revised during build: the first
  rule, "any manual stage nulls the row", nulled nearly every total, because old
  manual campaigns keep trickling Keitaro visits into any range — 13 of 836
  stages over 2026-09-07..13, carrying 7 of 12,769 visits and 0 of 125 sales.)

**Attribution basis** (`attribution` param):

- `conversion_date` (default = today's behaviour): each metric on its own event
  day — sends by send day, `clicks_human` by first-click day, `reached` by reach
  day, opt-outs by STOP day, conversions by conversion day (`stat_date`).
- `send_date` (cohort): the stages sent in the range, with everything they have
  produced to date (all `stat_date`s, all attributions, lifetime clickers and
  reach). Stage grain, keyed on `campaign_stages.sent_at` in ET.

**Identity:** creative = `campaign_stages.creative_id`; sending number =
`campaign_stages.provider_phone_id` (the opt-out endpoint uses the per-send
snapshot `stage_sends.provider_phone_id`); group names = the campaign's
`audience_contact_group_ids` (already exposed to tokens via `fresh-counts` and
the by-group report).

## 2. Changes to existing endpoints (additive only)

### `GET /api/reports/performance`
- Every row and `totals` gain `reached`, `clicks_human`, `click_to_reach_pct`,
  `reach_to_sale_pct`, `opt_rate`.
- New param `attribution=conversion_date|send_date`, default `conversion_date`,
  echoed in the response; any other value → `400`. `dimension=hourly` with
  `send_date` → `400`.
- `lib/reporting/stage-funnel.ts` `getStageMetricsInRange` gains `reached` per
  stage (counted for the stages already in its set) and an `attribution` option.
  No extra stages are seeded for reach: a reach is an offer click, which Keitaro
  books on the same day, so a reached stage already has a row — measured **0**
  reach-only stages on 1-day (38 stages) and 7-day (248 stages) ranges. The
  verification compares the sum with an independent org-wide count, so a future
  gap goes red. The Overview route calls it with the default and is unaffected.
- `group` splits `reached` on a new per-recipient `reach` weight basis (who
  reached), mirroring how sales split on the `sale` basis.
- `hourly` reuses its existing `offer_reached_at` query for `reached`;
  `clicks_human` buckets counted clickers by first-click ET hour.
- `totals.clicks_human` is deduped at report grain, never a sum of rows. If the
  existing `totals.counted_clickers` is a sum, it is corrected in the same change.

### `GET /api/campaigns/{campaignId}/stages`
- Each stage gains `reached`, `clicks_human`, `click_to_reach_pct`,
  `reach_to_sale_pct`, `opt_rate` (lifetime). `reached` is one extra `FILTER`
  count in the existing per-stage send query; the percentages use the existing
  `counted_clickers`, `keitaro_sales_count`, `inbound_opt_out_count` and
  `send_counts.sent`. Manual stages → `null` for reach fields.

### `GET /api/campaigns/{campaignId}/click-report`
- Tracked stage rows gain `clicks_human` (distinct human clickers for the
  campaign). Raw event counts stay.
- Targeted fix: the existing `human` event count gains `scored_at IS NOT NULL`
  (the shared `HUMAN_CLICK` predicate) so "human" has one definition.
- Manual stage rows: `clicks_human: null`.

### `GET /api/sends/today`
- Every stage object gains `creative_id` and `creative_slug` (LEFT JOIN
  `creatives`); `null` when absent.

### Item 7 — no new endpoint
`GET /api/dashboard/daily-activity?preset=custom&from=…&to=…` already returns
`days[].sales` / `days[].revenue` per ET conversion day from the tracker. It is
documented in the token API reference as the tracker daily sums. (Its sales take
`max(Keitaro, manual ledger)` per stage-day — identical while no campaign is
manual.)

### Rate limit — unchanged
The limiter charges exactly 1 per call, so `/api/campaigns/audit` costs 1 however
many campaigns it returns. Exempting it would leave the heaviest query uncapped.

## 3. New endpoints

All `GET`, org-scoped, added to `OPERATOR_ROUTE_MAP` as
`{ methods: ["GET"], token: ["GET"] }` (token-reachable pairs 33 → 38). Route
handlers stay thin: parse + validate params, call a `lib/reporting/grading.ts`
function, return its result — so the lib output **is** the response body and is
testable from scripts.

### `GET /api/reports/tails?date=YYYY-MM-DD` — `campaigns.view`
Conversions dated `date` (ET, default today) whose stage was sent on an earlier
ET day, grouped by campaign + creative + send day.

```json
{
  "date": "2026-09-13",
  "data": [
    { "campaign_id": 1262, "campaign_name": "…", "creative_id": 42,
      "creative_slug": "…", "send_date": "2026-09-11", "days_after_send": 2,
      "conversions": 3, "revenue": 201.0 }
  ],
  "totals": { "conversions": 21, "revenue": 1407.0,
              "same_day_conversions": 16, "tail_conversions": 5,
              "unknown_send_date_conversions": 0, "tail_revenue": 335.0 }
}
```
Source: `keitaro_stage_results` (`stat_date = date`) ⋈ `campaign_stages`
(`sent_at`). Only rows with conversions or revenue. `same_day` + `tail` +
`unknown_send_date` (stage has no `sent_at`; 0 on prod today) = `conversions`
by construction.

### `GET /api/reports/opt-outs?dimension=number|campaign|stage|group&from&to&granularity=day` — `campaigns.view`
Send-day cohort per ET day per dimension value. `from`/`to` default today ET,
max 31 days; `granularity` accepts only `day` (default). `maxDuration = 60`.

```json
{
  "dimension": "number", "granularity": "day", "basis": "send_date",
  "range": { "from": "2026-09-12", "to": "2026-09-13", "timezone": "America/New_York" },
  "data": [
    { "date": "2026-09-13", "key": "294", "label": "+1555…", "sent": 30000,
      "opt_outs": 912, "opt_rate": 3.04, "complete": false }
  ],
  "totals": [ { "date": "2026-09-13", "sent": 98000, "opt_outs": 2710,
                "opt_rate": 2.77, "complete": false } ]
}
```
- `sent`: tracked `stage_sends` (`status='sent'`) with `sent_at` on that ET day.
- `opt_outs`: `count(DISTINCT opt_out_id)` of attributions whose `stage_send_id`
  is one of those sends.
- `complete`: `true` once 72h (`OPT_OUT_ATTRIBUTION_WINDOW_HOURS`) have passed
  since the end of that ET day.
- Dimension keys: `number` = `stage_sends.provider_phone_id` (label = sending
  number); `campaign`; `stage` (label = campaign name + stage number); `group` =
  recipient's groups ∩ the campaign's targeted groups — a contact in two groups
  counts in both, so group rows do not sum to `totals` (stated in the doc).
- Manual-mode campaigns have no per-send rows and do not appear.

### `GET /api/creatives/{id}/usage` — `creatives.view`
Every place this creative has run, one row per campaign + sending number + ET
send day. `404` if the creative is not in the org.

```json
{
  "creative_id": 42, "creative_slug": "…",
  "data": [
    { "campaign_id": 1262, "campaign_name": "…", "group_names": ["Manifestation"],
      "sending_number": "+1555…", "date": "2026-09-11",
      "sends": 12000, "clicks_human": 310, "reached": 44, "conversions": 3 }
  ]
}
```
- Stages: `creative_id = id` and `sent_at IS NOT NULL` (archived included — it is
  history). Newest first.
- `clicks_human` deduped across the row's stages; `reached`/`sends`/`conversions`
  summed (additive). Manual stages → `reached: null`.

### `GET /api/campaigns/audit?status=active` — `campaigns.view` + `stages.view`
One row per campaign with its stages, for the "sales but no D2/D3 yet" sweep.
`status` ∈ `active` (default) | `paused` | `completed`.

```json
{
  "status": "active",
  "data": [
    { "campaign_id": 1262, "campaign_name": "…",
      "offer": { "id": 14, "name": "…" }, "group_names": ["Weight Loss"],
      "stage_count": 3, "last_send_date": "2026-09-12",
      "total_conversions": 9, "revenue": 603.0,
      "stages": [
        { "stage_id": 3401, "stage_seq": 1, "label": null, "split_index": null,
          "behavioral_tier": null, "status": "sent",
          "scheduled_date": "2026-09-10", "sent_date": "2026-09-10",
          "sent": 30000, "reached": 120, "conversions": 7, "creative_slug": "…" }
      ] }
  ]
}
```
- `stage_seq` = `stage_number`; split siblings share it, so `split_index` and
  `behavioral_tier` are included to tell them apart. Archived stages excluded.
- Lifetime per stage; conversions/revenue from the tracker.

### `GET /api/campaigns/{campaignId}/stages/{stageId}/hourly` — `stages.view`
Per ET clock hour of SEND (cohort), for first-half vs second-half checks.

```json
{ "stage_id": 3401, "link_mode": "tracked",
  "data": [ { "hour_start": "2026-09-10T14:00:00-04:00", "sent": 4100,
              "clicks_human": 96, "reached": 14, "opt_outs": 120 } ] }
```
- `clicks_human` / `reached` / `opt_outs` are attributed to the hour the
  recipient's message was sent. Manual stage → `data: []`, `link_mode: "manual"`.
  `404` if the stage is not in that campaign/org.

## 4. Errors, limits, performance

- Errors use `apiError(status, message, code, details)`: `400` validation (with
  `field`), `403` permission, `404` entity.
- `maxDuration = 60` on `reports/performance` (a long `send_date` range) and
  `reports/opt-outs`.
- Arrays in raw SQL go through `IN (${inList(ids)})`, never `${array}`.
- Rate limit unchanged (300/hour per token, 1 per call).

## 5. Verification

Per PR:
- `npx tsc --noEmit`; `npx eslint <changed files>`; `npm run check:authz`
  (route-map coverage + token ⊆ methods); `npm run check:docs`.
- `scripts/test-performance-report.ts` stays green — default basis still equals
  the Overview grand totals.
- New `scripts/verify-operator-grading.ts` (read-only, prod,
  `npx tsx --conditions=react-server`). Every figure is compared with an
  **independent SQL recomputation**, never the lib's own helper, and every
  "must be null/zero" check has a paired "must be non-null" control:
  - performance `conversion_date`: `totals.reached` = count of reaches in range;
  - performance `send_date`: `totals.sent` and `totals.sales` = direct sums for
    the stages sent in range;
  - tails: `totals.conversions` = Keitaro sum for that `stat_date`, and
    `same_day + tail` equals it;
  - opt-outs: per-day `totals` = direct cohort count; `opt_rate` arithmetic;
  - usage: row sums = stage-level sums for that creative;
  - audit: per-stage `sent`/`reached` = direct counts;
  - privacy sweep over every new payload: no `contact_id`, and every
    phone-shaped string is a known sending number.
- Post-deploy smoke on `https://camman.vercel.app` with an authenticated session:
  each changed/new endpoint returns 200 with the new keys, plus a nonexistent
  sibling path as a 404 control.

## 6. Delivery

Five small PRs in the Owner's priority order. None touches schema, STOP handling,
pacing, provider config, or writes data, so each ships on green under the
standing merge policy (PR body names what was verified and the previous
production deployment ID).

| PR | Items | Scope |
|---|---|---|
| 1 | 1, 4, 5b | `grading.ts` definitions; performance + stages fields (`conversion_date`); click-report `clicks_human` + scored-human fix; `sends/today` `creative_slug` |
| 2 | 2 | `attribution=send_date`; `/api/reports/tails` |
| 3 | 3 | `/api/reports/opt-outs` |
| 4 | 5a, 6 | `/api/creatives/{id}/usage`; `/api/campaigns/audit` |
| 5 | 8, 7 | stage `/hourly`; document `daily-activity` as tracker daily sums |

Docs per PR: `docs/operator-api.md`, `docs/04-features/operator-api-tokens.md`
(token-reachable count), `docs/04-features/reports-rollup.md`,
`docs/07-conventions.md` (grading definitions), `docs/CHANGELOG.md`, last-updated
dates. No `03-data-model.md` change (no schema change).

## Out of scope

UI changes; raw click-event counts on performance; any cache table, migration or
cron; a separate `revenue-daily` endpoint; rate-limit changes.
