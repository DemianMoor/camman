# CamMan API — reference for your Claude

_Last updated: 2026-09-14_

This is the whole API surface a personal token can reach. Hand this file to
Claude (or any tool) and it has everything it needs.

**Everything here is read-only and aggregate-only.** No contact rows, no phone
numbers of recipients, no exports. Provider/SSP names ARE shown by name as of
2026-09-11 (they used to be aliased as `Route A` / `Route B`); the registry name
is the display name.

---

## 1. Authenticating

Send your token as a bearer header on every request:

```
Authorization: Bearer cmt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Base URL: `https://camman.vercel.app`

```bash
curl -s https://camman.vercel.app/api/contacts/base-stats \
  -H "Authorization: Bearer $CAMMAN_TOKEN"
```

The token carries **your own permissions and nothing more**. Anything you cannot
open in the browser, the token cannot fetch either.

### When a request fails

| Status | Meaning | What to do |
| --- | --- | --- |
| `401` | Token invalid, revoked, expired, or API access switched off for your account | Ask the Owner. The reason is in their audit log, not in this response. |
| `403` | The endpoint is not on the token allowlist | Not a bug. Use one of the endpoints below. Repeated 403s alert the Owner. |
| `429` | More than **300 requests in one hour** | Wait for the hour to roll over. Retrying does **not** extend the lockout, but it does not help either. |
| `503` on `/api/audience/fresh-counts` | The rollup has not been computed yet | Retry in a few minutes. Never read this as "zero leads". |

Every request is logged against your token: endpoint, method, time, IP. Denials
and rate-limit hits are logged individually and alert the Owner.

---

## 2. Fresh leads — what is left to assign

**`GET /api/audience/fresh-counts`**

The one endpoint built specifically for this workflow. Answers "how many
contacts can I still put in a campaign", org-wide and per vertical.

```bash
curl -s https://camman.vercel.app/api/audience/fresh-counts \
  -H "Authorization: Bearer $CAMMAN_TOKEN"
```

```json
{
  "eligible_total": 671183,
  "not_used": { "7d": 440309, "30d": 127247 },
  "by_group": [
    { "group_name": "Manifestation", "total": 196319,
      "not_used": { "7d": 137965, "30d": 21637 } },
    { "group_name": "Weight Loss", "total": 92275,
      "not_used": { "7d": 3911, "30d": 3777 } }
  ],
  "computed_at": "2026-09-04T14:11:02.417Z",
  "stale_seconds": 340,
  "definition": "not_used = not snapshotted into any campaign that ran (active/paused/completed) in the window; excludes archived contacts and opt-outs"
}
```

**Read `stale_seconds` before quoting a number.** It is refreshed every 30
minutes, so a few minutes of age is normal; a large value means the refresh is
failing and the numbers should not be trusted.

**What the numbers mean, precisely:**

- `eligible_total` — contacts that are not archived and have not opted out.
  Opt-outs are excluded everywhere in this response; a suppressed contact is not
  inventory.
- `not_used["7d"]` — of those, the ones **not put into any campaign** that ran in
  the last 7 days. This is the number to use for "what can I load today".
- `by_group` — the same two numbers per vertical. `total` is the group's whole
  eligible size, so `total - not_used["7d"]` is how much of that vertical is
  already committed this week.

⚠️ **"Not used" means "not put in a campaign", not "not messaged".** A contact
snapshotted into a campaign counts as used even if its message has not fired
yet — which is what you want, because it cannot be assigned twice. It matches
the "Not Used N Days" segments in the app exactly, so the two agree.

One wrinkle worth knowing: the window is measured from when the **campaign** was
created, not when the message went out. A long-running campaign created 45 days
ago that sent yesterday leaves its contacts counted as "not used in 30d".

---

## 3. Results

### Performance report

**`GET /api/reports/performance`**

| Param | Values |
| --- | --- |
| `dimension` | `number`, `offer`, `sequence`, `group` or `hourly` |
| `from`, `to` | `YYYY-MM-DD`, in ET; today if omitted; at most 92 days apart |
| `provider_phone_id` | optional — only stages sent from that number |
| `attribution` | `conversion_date` (default) or `send_date` — see below. `hourly` accepts only the default |

```bash
curl -s "https://camman.vercel.app/api/reports/performance?dimension=offer&from=2026-09-07&to=2026-09-13" \
  -H "Authorization: Bearer $CAMMAN_TOKEN"
```

Response: `{ dimension, attribution, data: [row, …], totals, refreshedAt, providers, range }`.
Every row, and `totals`, carries `sent`, `opt_outs`, `clickers` (the tracker's
clean landing visits — not human clicks), `redirects`, `counted_clickers`,
`sales`, `revenue`, `cost`, and the grading fields `reached`, `clicks_human`,
`click_to_reach_pct`, `reach_to_sale_pct` and `opt_rate` (see §7).

**Which days a number belongs to (`attribution`):**

- `conversion_date` (default) — each metric is dated by its own event: sends by
  send day, `reached` by the day the recipient reached the offer, `clicks_human`
  by first click, sales and revenue by conversion day. Use it for "what happened
  on these days".
- `send_date` — takes the stages **sent** in the range and counts everything they
  have produced so far, whenever it happened. Use it to grade a send day. Its
  numbers keep growing for days after the send: about a quarter of sales arrive
  on a later day (see Tails, below), and late STOPs and clicks keep landing.

One real row, 2026-09-07..13 (offer name redacted, cost rounded):

```json
{
  "key": "118", "label": "<offer name> - 15173 (lhj)",
  "sent": 183664, "opt_outs": 5450, "clickers": 4301, "redirects": 357,
  "reached": 400, "counted_clickers": 4480, "clicks_human": 4480,
  "lifetime_clickers": 10934, "lifetime_revenue": 11599,
  "sales": 50, "revenue": 3650, "cost": 1796.56,
  "click_to_reach_pct": 8.93, "reach_to_sale_pct": 12.5, "opt_rate": 2.97
}
```

### Tails — conversions that came in after the send day

**`GET /api/reports/tails?date=YYYY-MM-DD`** (an ET day; today if omitted)

Tracker conversions dated that day, split by when the stage that earned them was
sent. About a quarter of sales land on a later day than their send — up to 34
days later over the 30 days to 2026-09-14 — so check tails before grading a send
day.

```bash
curl -s "https://camman.vercel.app/api/reports/tails?date=2026-09-14" \
  -H "Authorization: Bearer $CAMMAN_TOKEN"
```

Real response, early on 2026-09-14 (campaign name redacted):

```json
{
  "date": "2026-09-14",
  "data": [
    { "campaign_id": 1251, "campaign_name": "<campaign name>", "creative_id": 726,
      "creative_slug": "8h9tap", "send_date": "2026-09-08", "days_after_send": 6,
      "conversions": 1, "revenue": 73 }
  ],
  "totals": { "conversions": 1, "revenue": 73, "same_day_conversions": 0,
              "tail_conversions": 1, "unknown_send_date_conversions": 0,
              "tail_revenue": 73 }
}
```

- `data` lists only the tails, grouped by campaign + creative + send day, oldest
  send first.
- `same_day_conversions + tail_conversions + unknown_send_date_conversions`
  always equals `conversions`. "Unknown" means the stage has no send time, or one
  later than the conversion day.
- An impossible date (e.g. `2026-02-31`) returns `400`.

### Delivery report

**`GET /api/reports/delivery`** — delivery rate per sending route, same
`from`/`to` params. Providers appear by name.

### Campaigns and stages

- **`GET /api/campaigns/list`** — `page`, `pageSize`, `search`, `showArchived`,
  `sortBy`, `sortDir`. Response: `{ data, totalCount, page, pageSize }`.
- **`GET /api/campaigns/{campaignId}`** — one campaign.
- **`GET /api/campaigns/{campaignId}/stages`** — its stages. Each stage carries
  its whole-life `reached`, `clicks_human`, `click_to_reach_pct`,
  `reach_to_sale_pct` and `opt_rate` (§7), next to the inputs that feed them —
  `send_counts.sent`, `inbound_stop_count` and `keitaro_sales_count`. Real
  excerpt, one stage:
  `"send_counts": { "sent": 1376, … }, "inbound_stop_count": 45, "keitaro_sales_count": 1, "reached": 43, "clicks_human": 256, "click_to_reach_pct": 16.8, "reach_to_sale_pct": 2.33, "opt_rate": 3.27`.
- **`GET /api/campaigns/{campaignId}/stages/{stageId}`** — one stage.
- **`GET /api/campaigns/{campaignId}/activity`** — timeline of what happened.
- **`GET /api/campaigns/{campaignId}/click-report`** — per stage: raw click events
  by class (`raw`, `suspect`, `bot`, `prefetch`, `unknown`, `unscored`), `human`
  (scored human click events) and `clicks_human` (distinct human clickers, §7).
  Grade on `clicks_human`: raw clicks are about 91% bots.
- **`GET /api/offers/{offerId}/report`** — one offer across campaigns.

### Dashboard

- **`GET /api/dashboard/stats`** — headline totals, accepts a range.
- **`GET /api/dashboard/active-campaigns`**, **`/active-stages`**,
  **`/daily-activity`**.

---

## 4. Today's sending

**`GET /api/sends/today`**

Every stage in play today (ET), grouped by sending number, each with its
operational status — the triage view.

```bash
curl -s https://camman.vercel.app/api/sends/today \
  -H "Authorization: Bearer $CAMMAN_TOKEN"
```

Includes `prepared_by_phone` so you can see per-number load for the day.
Sending numbers are shown, and so is the provider behind them, by name. Every
stage also carries `creative_id` and `creative_slug`, so a same-day text
collision — one creative on two numbers, or twice on one number — is visible
from this single call. Real excerpt, one stage:
`{ "stage_id": 4251, …, "creative_id": 703, "creative_slug": "tbhprk", … }`.

**`GET /api/sends/state`** — whether sending is on, paused, or circuit-broken.

---

## 5. Audience sizing

These take a **POST** body (the filter does not fit in a query string) but write
nothing.

### Preview an audience before building a campaign

**`POST /api/campaigns/audience-preview`**

```bash
curl -s https://camman.vercel.app/api/campaigns/audience-preview \
  -H "Authorization: Bearer $CAMMAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"audience_segment_ids":[195],"audience_contact_group_ids":[],"exclude_in_use_contacts":true}'
```

Returns the count that would be frozen, plus the breakdown (how many were
excluded for opt-out, how many are in use elsewhere).

### Segment counts

- **`GET /api/segments/list`** — every segment with its cached audience count
  and `stats.updated_at`. ⚠️ **That count is only as fresh as `updated_at`** — it
  is not recomputed automatically. For a live number use the preview below.
- **`GET /api/segments/{id}`** — one segment.
- **`GET /api/segments/{id}/rules`** — its rules.
- **`POST /api/segments/{id}/rules/preview`** — recomputes the segment's audience
  **live** (10s limit; returns `truncated: true` if it times out). Use this when
  the cached number is stale. It also refreshes the cached value as a side
  effect.
- **`POST /api/segments/overlaps`** — how much two or more segments share.
- **`GET /api/campaigns/{campaignId}/stages/{stageId}/audience-count`** — the
  size of one stage's audience.

### Contact base

- **`GET /api/contacts/base-stats`** — totals: contacts, archived, opt-outs (with
  a per-reason breakdown), opt-ins, clickers.
- **`GET /api/contacts/carrier-stats`** — histogram by carrier, line type and
  messaging status.

Both are counts only. There is no endpoint on this list that returns a contact.

---

## 6. Creatives and registry

- **`GET /api/creatives/list`** — `offer_id`, `status`, plus the standard list
  params. Carries the spam score where one is cached.
- **`GET /api/creatives/{id}`** — one creative.
- **`GET /api/brands/list`**, **`/api/offers/list`**, **`/api/networks/list`** —
  names and ids so report rows are legible.
- **`GET /api/provider-phones/list`** — sending numbers, each with its provider
  by name.
- **`GET /api/providers/list`** — the providers themselves, by name.
- **`GET /api/me`** — who this token belongs to and what role it carries.

---

## 7. Grading metrics — what the numbers mean

| Field | Meaning |
| --- | --- |
| `reached` | Messages whose recipient reached the offer page (their first offer click, tracked per recipient). |
| `clicks_human` | Distinct recipients with at least one click scored human, or a conversion. The same number the platform's EPC divides by. |
| `click_to_reach_pct` | `reached ÷ clicks_human × 100`. Can exceed 100: a recipient can reach the offer without a click the scorer called human. |
| `reach_to_sale_pct` | `conversions ÷ reached × 100`. Conversions come from the tracker (`sales` on report rows, `keitaro_sales_count` on stages). |
| `opt_rate` | `opt_outs ÷ sent × 100`. |

- **Percent units**, 2 decimals: `3.04` means 3.04%.
- **`null` means "cannot be computed", never zero** — a denominator of 0, or a row
  made up only of manual-mode stages (those have no per-recipient reach).
- **Grade on `clicks_human`.** Raw clicks are about 91% bots (only click-report
  shows them), and `clickers` on report rows is the tracker's landing-visit
  count, not a human-click count.
- **`reached` is not `redirects`.** `redirects` counts the tracker's clean offer
  click events; `reached` counts recipients. They run close (1,226 vs 1,115 over
  2026-09-07..13) but measure different things.

---

## 8. Rules of the road

1. **300 requests per hour.** Cache what you fetch; do not poll in a loop.
2. **Do not retry a 403.** The endpoint is not on the allowlist and never will
   be by retrying. Ten denials in an hour alerts the Owner.
3. **Quote `stale_seconds` / `stats.updated_at`** whenever you report a number
   that came from a cache. A confidently stale number is the failure mode this
   API was built to avoid.
4. **The token is a secret.** It is shown once and cannot be recovered. If it
   leaks, tell the Owner and they will revoke it.

---

## 9. What is deliberately not here

Not an oversight, and not something a retry or a different URL will reach:

- Contact rows, phone numbers of recipients, any CSV export or import.
- Contact groups as a list — group **names** appear in `fresh-counts`, but the
  group endpoints themselves are closed.
- Anything that writes: creating or editing campaigns, stages, creatives or
  segments; approving, scheduling or sending; compliance controls; user
  management.
- Opt-out and clicker lists, the audit log, deletion requests, partner/drip
  reporting.

Doing any of the above means opening CamMan in a browser and doing it as
yourself.
