# CamMan API — reference for your Claude

_Last updated: 2026-09-04_

This is the whole API surface a personal token can reach. Hand this file to
Claude (or any tool) and it has everything it needs.

**Everything here is read-only and aggregate-only.** No contact rows, no phone
numbers of recipients, no exports. Sending routes (SSPs) appear as `Route A`,
`Route B` … rather than by name — that is deliberate and permanent.

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
| `dimension` | the breakdown you want (campaign, offer, creative, number, …) |
| `from`, `to` | `YYYY-MM-DD`, in ET |

```bash
curl -s "https://camman.vercel.app/api/reports/performance?dimension=offer&from=2026-09-01&to=2026-09-04" \
  -H "Authorization: Bearer $CAMMAN_TOKEN"
```

Sends, delivered, clicks, conversions, revenue, cost, EPC per row.

### Delivery report

**`GET /api/reports/delivery`** — delivery rate per sending route, same
`from`/`to` params. Sending routes appear as `Route A` / `Route B`.

### Campaigns and stages

- **`GET /api/campaigns/list`** — `page`, `pageSize`, `search`, `showArchived`,
  `sortBy`, `sortDir`. Response: `{ data, totalCount, page, pageSize }`.
- **`GET /api/campaigns/{campaignId}`** — one campaign.
- **`GET /api/campaigns/{campaignId}/stages`** — its stages.
- **`GET /api/campaigns/{campaignId}/stages/{stageId}`** — one stage.
- **`GET /api/campaigns/{campaignId}/activity`** — timeline of what happened.
- **`GET /api/campaigns/{campaignId}/click-report`** — click breakdown.
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
Sending numbers are shown; the provider behind them is `Route A` / `Route B`.

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
- **`GET /api/provider-phones/list`** — sending numbers, each tagged with its
  `Route X` alias.
- **`GET /api/providers/list`** — the routes themselves, as aliases.
- **`GET /api/me`** — who this token belongs to and what role it carries.

---

## 7. Rules of the road

1. **300 requests per hour.** Cache what you fetch; do not poll in a loop.
2. **Do not retry a 403.** The endpoint is not on the allowlist and never will
   be by retrying. Ten denials in an hour alerts the Owner.
3. **Quote `stale_seconds` / `stats.updated_at`** whenever you report a number
   that came from a cache. A confidently stale number is the failure mode this
   API was built to avoid.
4. **The token is a secret.** It is shown once and cannot be recovered. If it
   leaks, tell the Owner and they will revoke it.

---

## 8. What is deliberately not here

Not an oversight, and not something a retry or a different URL will reach:

- Contact rows, phone numbers of recipients, any CSV export or import.
- Contact groups as a list — group **names** appear in `fresh-counts`, but the
  group endpoints themselves are closed.
- Provider names. Sending routes are `Route A`, `Route B` … permanently.
- Anything that writes: creating or editing campaigns, stages, creatives or
  segments; approving, scheduling or sending; compliance controls; user
  management.
- Opt-out and clicker lists, the audit log, deletion requests, partner/drip
  reporting.

Doing any of the above means opening CamMan in a browser and doing it as
yourself.
