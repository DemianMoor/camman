# CamMan API — reference for your Claude

_Last updated: 2026-09-20_

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
| `503` on `/api/audience/pools` | The rollup has not been computed yet, or the offer first sent after the last refresh (`details.reason`) | Retry within 30 minutes. Never read this as "empty pool". |

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

### Pools — who could still get an offer

**`GET /api/audience/pools?offer_id={id}&rest_days=7`**

For one offer, per contact group: how many contacts have never received it, how
many of those are rested, and the two re-touch pools. Use it to size a campaign
for an offer before building it.

| Param | Values |
| --- | --- |
| `offer_id` | required — the offer's id (from `/api/offers/list`) |
| `rest_days` | whole number 0–30, default 7 |

```bash
curl -s "https://camman.vercel.app/api/audience/pools?offer_id=118&rest_days=7" \
  -H "Authorization: Bearer $CAMMAN_TOKEN"
```

Real response (offer name redacted; 3 of 12 groups shown):

```json
{
  "offer_id": 118, "offer_name": "<offer name>", "rest_days": 7,
  "data": [
    { "group_name": "Manifestation", "group_total_eligible": 195181,
      "never_received": 165370, "never_received_rested": 147882,
      "received_not_clicked_rested": 22350,
      "clickers_non_buyers": 1289, "clickers_non_buyers_rested": 68 },
    { "group_name": "Memory", "group_total_eligible": 142002,
      "never_received": 97659, "never_received_rested": 41067,
      "received_not_clicked_rested": 2789,
      "clickers_non_buyers": 1563, "clickers_non_buyers_rested": 89 },
    { "group_name": "AstroEnergy", "group_total_eligible": 131452,
      "never_received": 119860, "never_received_rested": 118202,
      "received_not_clicked_rested": 7042,
      "clickers_non_buyers": 326, "clickers_non_buyers_rested": 3 }
  ],
  "totals": { "group_total_eligible": 708823, "never_received": 479441,
              "never_received_rested": 390119, "received_not_clicked_rested": 73417,
              "clickers_non_buyers": 9637, "clickers_non_buyers_rested": 214 },
  "computed_at": "2026-09-14T16:02:23.247Z",
  "stale_seconds": 86,
  "definition": "eligible = not archived and not opted out; received = at least one sent message of this offer; …"
}
```

| Field | Meaning |
| --- | --- |
| `group_total_eligible` | Contacts in the group that are not archived and have not opted out. |
| `never_received` | Of those, never sent a message of this offer. |
| `never_received_rested` | Of those, rested: their last message of **any** offer went out at least `rest_days` days ago, or they have never been messaged. **The fresh inventory for this offer.** |
| `received_not_clicked_rested` | Received this offer, never clicked it (human click), never bought it, and rested — the re-touch pool. |
| `clickers_non_buyers` | Clicked this offer (a human click, the same definition as `clicks_human`) but never bought it. |
| `clickers_non_buyers_rested` | Of those, rested. |

- ⚠️ **"Rested" is measured from the last message actually sent**, of any offer —
  not from when a campaign was created. This deliberately differs from
  `fresh-counts`, whose windows follow campaign creation, so the two do not
  reconcile and are not meant to.
- **Rest is measured from `computed_at`**, the moment of the snapshot. The rollup
  refreshes every 30 minutes; read `stale_seconds` before quoting a number.
- A contact in two groups counts in both, so group rows do not add up to
  `totals`. `totals` is every eligible contact in the organisation. Only active
  contact groups appear.
- "Bought" means a conversion on this offer recorded by the tracker.
- `400` for a missing or non-numeric `offer_id`, or a `rest_days` outside 0–30
  (`details.field` names the parameter). `404` for an offer outside your
  organisation.
- `503` with `details.reason`: `rollup_not_ready` (the first refresh has not run)
  or `offer_not_in_rollup_yet` (the offer's first message went out after the
  last refresh — wait up to 30 minutes). An offer that has never sent answers
  normally: nobody has received it.

---

## 3. Results

### Performance report

**`GET /api/reports/performance`**

| Param | Values |
| --- | --- |
| `dimension` | `number`, `offer`, `sequence`, `group`, `hourly` or `creative` (API only — see Creative bank, below) |
| `from`, `to` | `YYYY-MM-DD`, in ET; today if omitted; at most 92 days apart |
| `provider_phone_id` | optional — only stages sent from that number |
| `attribution` | `conversion_date` (default) or `send_date` — see below. `hourly` accepts only the default |

```bash
curl -s "https://camman.vercel.app/api/reports/performance?dimension=offer&from=2026-09-07&to=2026-09-13" \
  -H "Authorization: Bearer $CAMMAN_TOKEN"
```

Response: `{ dimension, attribution, data: [row, …], totals, refreshedAt, providers, event_types, range }`.
Every row, and `totals`, carries `sent`, `opt_outs`, `clickers` (the tracker's
clean landing visits — not human clicks), `redirects`, `counted_clickers`,
`sales`, `revenue`, `cost`, and the grading fields `reached`, `clicks_human`,
`click_to_reach_pct`, `reach_to_sale_pct` and `opt_rate` (see §7).

**Per-event-type breakdown (additive; no existing field changed meaning).**
`event_types` is the org's event-type registry — `{ key, label, display_order,
is_purchase, counts_revenue, is_retarget_signal, archived }` — and every row and
`totals` carries `events`, `unmapped` and `manual_topup`:

- `events` maps `event_types.key` → `{ n, pending_n, revenue, pending_revenue }`.
  `n` counts events with status `pending` or `approved`; `pending_n` is the held
  SUBSET of `n`, never added to it. `revenue`/`pending_revenue` are `0` for a
  type whose `counts_revenue` is false, by construction.
- `unmapped` counts conversions in scope whose tracker type matched no mapping.
  ⭐ **They are in NO other field** — not `sales`, not `revenue`, not `events` —
  so nothing but this number reveals them.
- `manual_topup` is the part of `sales` that came from the manual result tally
  rather than the tracker ledger.

⭐ **`events` alone does not explain `sales`.** The identity is

```
sales = Σ over is_purchase types of events[key].n  +  manual_topup  +  strays
```

`sales` resolves `is_purchase` through a non-org-scoped id list while `events`
comes from an org-scoped join, so a cross-organisation event type is counted by
the scalar and placed under no key; `unmapped` is where it surfaces. A client
that renders the breakdown as an explanation of `sales` must render `unmapped`
beside it or it under-explains its own total.

`pending_revenue` is computed on **every** dimension, hourly included, and a `0`
there is a measurement. (Between 2026-09-19 and the same day's fix, hourly's
scalar was a hard-coded NOT-COMPUTED zero and this section told clients to read
held money from `events` instead. That workaround is retired: `getHourlyReport`
now runs a pending series off the same ledger, hour bucket and clause family as
its approved `revenue`, so `pending_revenue = Σ events[key].pending_revenue +
cross-org strays` holds on hourly exactly as on the other dimensions. If you
implemented the workaround, delete it — it now reads the same number twice.)

⚠️ **`dimension=creative&range=lifetime` serves a stored hourly blob.** For up to
an hour after a deploy it can report an empty `events` map, which is
indistinguishable from a configured-but-idle event type; `stale_seconds` in the
response tells the two apart.

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
  "click_to_reach_pct": 8.93, "reach_to_sale_pct": 12.5, "opt_rate": 2.97,
  "events": {
    "registration": { "n": 214, "pending_n": 0, "revenue": 0,    "pending_revenue": 0 },
    "purchase":     { "n": 47,  "pending_n": 3, "revenue": 3650, "pending_revenue": 240 }
  },
  "unmapped": 0, "manual_topup": 3
}
```

The last three keys are the Phase 5 additions shown on this row for completeness —
that row's `sales` of 50 is `47` purchases `+ 3` manual top-up `+ 0` strays, which
is the identity above. **They are additive: every field that was there before this
row means exactly what it meant before.** A consumer that ignores `events`,
`unmapped` and `manual_topup` reads the same numbers it always did.

### Creative bank — `dimension=creative`

**`GET /api/reports/performance?dimension=creative`** — operator API only; there
is no Reports tab for it.

One row per creative × offer: a creative sent on two offers is two rows. Every
column of the other dimensions and the grading fields (§7), plus:

⭐ **Both creative bodies carry `event_types` too, deliberately, although no
screen renders them.** The rows carry `events` / `unmapped` like every other
dimension, and a key is not a label: without the registry a client has a map of
`event_types.key` it cannot name, order, or tell "counts revenue" from "signal".
This is the one dimension whose consumer has no UI to fall back on, so dropping
the registry here would be dropping it where it is least replaceable.

| Field | Meaning |
| --- | --- |
| `creative_id`, `offer_id` | The row's creative and offer. `label` is `"{slug} — {offer name}"`. |
| `first_sent_date`, `last_sent_date` | First and last ET day a stage of this row was sent inside the range (all time for `range=lifetime`). `null` when none was — the row then carries only later conversions. |
| `distinct_send_days` | How many different ET days it was sent on in that window. |
| `rpm` | Revenue per 1,000 messages sent, 2 decimals; `null` at 0 sent. Also on `totals`. |

| Param (creative only) | Values |
| --- | --- |
| `range=lifetime` | All time, from the first send — ignores the 92-day cap. Not combinable with `from`, `to` or `provider_phone_id`. |
| `offer_id` | Only that offer's rows; `totals` become that offer's numbers (equal to its `dimension=offer` row). Not combinable with `provider_phone_id`. |
| `min_sent` | Hide rows with fewer sends (default 0). `totals` stay whole; `hidden_rows` says how many rows were hidden. |
| `sortBy` | `revenue` (default), `rpm`, `sent` or `click_to_reach_pct` — highest first, empty values last. |

Any of these four with another dimension is a `400`.

```bash
curl -s "https://camman.vercel.app/api/reports/performance?dimension=creative&range=lifetime&min_sent=1500&sortBy=rpm" \
  -H "Authorization: Bearer $CAMMAN_TOKEN"
```

Real top row of that call on 2026-09-14 (offer name redacted, cost rounded):

```json
{
  "key": "337:58", "label": "48562j — <offer name>", "creative_id": 337, "offer_id": 58,
  "sent": 2167, "opt_outs": 83, "clickers": 300, "redirects": 32,
  "reached": 37, "counted_clickers": 475, "clicks_human": 475,
  "sales": 9, "revenue": 414, "cost": 18.43,
  "first_sent_date": "2026-07-17", "last_sent_date": "2026-09-14", "distinct_send_days": 31,
  "click_to_reach_pct": 7.79, "reach_to_sale_pct": 24.32, "opt_rate": 3.83, "rpm": 191.05
}
```

The response also carries `sort_by`, `min_sent`, `offer_id` and `hidden_rows`
(that call hid 117 of 418 lifetime rows), and for lifetime `computed_at`,
`stale_seconds` and `range: { "lifetime": true, "from": "2026-05-29", "to": "2026-09-14" }`.

- ⚠️ **Grade with `min_sent>=1500`.** Below that, one sale swings `rpm` and the
  rates wildly, and ranking the bank without it puts micro cells on top by noise.
- **Lifetime rows are heavy and cached hourly** (two all-time passes, about 40s).
  Read `stale_seconds` before quoting a number. `503` with
  `details.reason: "rollup_not_ready"` means the first hourly refresh has not
  run. `refreshedAt` is the last tracker sync as of that snapshot.
- `attribution` works as on every other dimension, lifetime included.
- Human clickers are counted once per creative × offer, so the rows'
  `clicks_human` do not add up to `totals` — the same rule as every dimension.

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

### Opt-outs by number, campaign, stage or group, per day

**`GET /api/reports/opt-outs`**

| Param | Values |
| --- | --- |
| `dimension` | `number`, `campaign`, `stage` or `group` (required) |
| `from`, `to` | `YYYY-MM-DD`, in ET; today if omitted; at most **14 days** per call |
| `granularity` | `day` (the only value; may be omitted) |

Each row is a **send-day cohort**: the STOPs credited to the messages **sent** on
that ET day, divided by those messages. A STOP is credited to the single most
recent stage that messaged that person within 72 hours, so it always lands on the
day of the send that caused it — which is what a per-number daily ceiling needs.

```bash
curl -s "https://camman.vercel.app/api/reports/opt-outs?dimension=number&from=2026-09-12&to=2026-09-12" \
  -H "Authorization: Bearer $CAMMAN_TOKEN"
```

Real response (sending numbers shortened to their last 4 digits here; the API
returns them in full):

```json
{
  "dimension": "number", "granularity": "day", "basis": "send_date", "window_hours": 72,
  "range": { "from": "2026-09-12", "to": "2026-09-12", "timezone": "America/New_York" },
  "data": [
    { "date": "2026-09-12", "key": "285", "label": "…5147", "sent": 28911, "opt_outs": 967, "opt_rate": 3.34, "complete": false },
    { "date": "2026-09-12", "key": "286", "label": "…4292", "sent": 27024, "opt_outs": 465, "opt_rate": 1.72, "complete": false },
    { "date": "2026-09-12", "key": "27",  "label": "…0404", "sent": 13662, "opt_outs": 485, "opt_rate": 3.55, "complete": false },
    { "date": "2026-09-12", "key": "43",  "label": "…1637", "sent": 12678, "opt_outs": 423, "opt_rate": 3.34, "complete": false },
    { "date": "2026-09-12", "key": "114", "label": "…3688", "sent": 12167, "opt_outs": 197, "opt_rate": 1.62, "complete": false },
    { "date": "2026-09-12", "key": "261", "label": "…2936", "sent": 6311,  "opt_outs": 74,  "opt_rate": 1.17, "complete": false }
  ],
  "totals": [
    { "date": "2026-09-12", "sent": 100753, "opt_outs": 2611, "opt_rate": 2.59, "complete": false }
  ]
}
```

- **`complete`** turns `true` once 72 hours have passed since the day ended. Until
  then late STOPs can still land on that day, so its rate can only go up.
  (2026-09-12 above completes at 00:00 ET on 2026-09-16.)
- **`label`** is the sending number, the campaign name, "campaign · stage N", or
  the contact group's name. A send with no sending number is key `-1`, "No number".
- **`totals`** are per day, computed from the sends themselves. For `number`,
  `campaign` and `stage` the rows add up to them. For `group` they do **not**: a
  contact in two of the campaign's targeted groups counts in both rows.
- `400` for a missing or unknown `dimension`, any `granularity` other than `day`,
  an impossible date, `from` after `to`, or more than 14 days.
- Manual-mode campaigns have no per-message rows and do not appear.

### Creative usage — where a text has already run

**`GET /api/creatives/{id}/usage`**

Every campaign, sending number and ET day this creative has been sent on, with
the results of each. Use it to check cohort freshness and the one-text-one-number
-per-day rule before scheduling the creative again.

```bash
curl -s https://camman.vercel.app/api/creatives/779/usage \
  -H "Authorization: Bearer $CAMMAN_TOKEN"
```

Real response (campaign names redacted, sending numbers shortened to their last 4
digits; the API returns them in full):

```json
{
  "creative_id": 779,
  "creative_slug": "v3eg2u",
  "data": [
    { "campaign_id": 1290, "campaign_name": "<campaign name>", "group_names": ["WL_Sep_2026"],
      "sending_number": "…5147", "date": "2026-09-12",
      "sends": 4500, "clicks_human": 146, "reached": 7, "conversions": 1 },
    { "campaign_id": 1276, "campaign_name": "<campaign name>", "group_names": ["WL_Sep_2026"],
      "sending_number": "…5147", "date": "2026-09-10",
      "sends": 4000, "clicks_human": 86, "reached": 4, "conversions": 2 }
  ]
}
```

That example is exactly what this endpoint exists to catch: the same text went to
the same contact group from the same number twice in three days.

- One row per campaign + sending number + send day, newest first. Archived stages
  are included — this is history.
- `clicks_human` counts each person once across the row's stages; `sends`,
  `reached` and `conversions` add up. `reached` is `null` for a manual-mode
  campaign (no per-message tracking).
- `404` if the creative is not in your organisation; `400` for a non-numeric id.

### Campaign audit — every campaign and its stages in one call

**`GET /api/campaigns/audit?status=active`** (`active` is the default; also
`paused` or `completed`)

One entry per campaign in that status, with all its live stages — for the daily
"which campaigns have sales but no Day 2 / Day 3 yet" sweep, instead of one call
per campaign. It counts as **one** request against the 300/hour limit.

```bash
curl -s "https://camman.vercel.app/api/campaigns/audit?status=active" \
  -H "Authorization: Bearer $CAMMAN_TOKEN"
```

Real entry (campaign and offer redacted):

```json
{
  "campaign_id": 1307, "campaign_name": "<campaign name>",
  "offer": { "id": "<offer id>", "name": "<offer name>" },
  "group_names": ["Blood Sugar"],
  "stage_count": 2, "last_send_date": "2026-09-12",
  "total_conversions": 2, "revenue": 200,
  "stages": [
    { "stage_id": 4246, "stage_seq": 1, "label": "Day 1", "split_index": null, "behavioral_tier": null,
      "status": "success", "scheduled_date": "2026-09-12", "sent_date": "2026-09-12",
      "sent": 3411, "reached": 11, "conversions": 2, "creative_slug": "53wp5d" },
    { "stage_id": 4277, "stage_seq": 2, "label": "Day 2", "split_index": null, "behavioral_tier": null,
      "status": "pending", "scheduled_date": "2026-09-14", "sent_date": null,
      "sent": 0, "reached": 0, "conversions": 0, "creative_slug": "ytf396" }
  ]
}
```

- `stage_seq` is the stage number. A/B splits and behavioural lanes share it, so
  use `split_index` and `behavioral_tier` to tell siblings apart.
- ⚠️ **`behavioral_tier` may now carry `3` (Registered), as well as `0` (Ignored),
  `1` (Clicked), `2` (Reached offer) and `null` (not a lane).** Migration 0184
  widened the stored set on 2026-09-18. This is **additive** — no existing value
  changed meaning and no stage was rewritten — but a consumer that enumerated the
  old `{0,1,2,null}` set should be widened rather than left to fall through a
  `switch`. It **never** carries `4`: tier 4 is *purchased*, which exits the
  sequence, is not a lane, and is refused by both the API and the database CHECK.
  See [behavioral-lanes.md](04-features/behavioral-lanes.md).
- `sent`, `reached` and `conversions` are the stage's whole life; `conversions` and
  `revenue` come from the tracker. `reached` is `null` for manual-mode stages.
- A campaign whose stages are all archived still appears, with `stages: []`.
- `400` for any other `status`.

### Send groups — first half vs second half of a cell

**`GET /api/campaigns/{campaignId}/stages/{stageId}/send-groups?groups=2`**

The stage's sent messages in the order they went out, cut into equal groups —
two by default (first half, second half), up to 10. Use it on cells of 4,000+
sends to see whether a text held up across the whole send. A cell goes out in a
few minutes, which is why this splits by send order rather than by clock hour.

```bash
curl -s "https://camman.vercel.app/api/campaigns/1258/stages/4095/send-groups?groups=2" \
  -H "Authorization: Bearer $CAMMAN_TOKEN"
```

Real response:

```json
{
  "stage_id": 4095, "campaign_id": 1258, "link_mode": "tracked", "groups": 2,
  "sent": 4500, "pending_sends": 0, "opt_outs_complete": true,
  "data": [
    { "group": 1, "first_sent_at": "2026-09-09T14:15:35Z", "last_sent_at": "2026-09-09T14:17:14Z",
      "sent": 2250, "clicks_human": 84, "reached": 10, "opt_outs": 73,
      "click_to_reach_pct": 11.9, "opt_rate": 3.24 },
    { "group": 2, "first_sent_at": "2026-09-09T14:17:15Z", "last_sent_at": "2026-09-09T14:18:54Z",
      "sent": 2250, "clicks_human": 84, "reached": 10, "opt_outs": 66,
      "click_to_reach_pct": 11.9, "opt_rate": 2.93 }
  ]
}
```

- Groups differ in size by at most one message; the earlier groups take the
  extra. Times are UTC.
- `clicks_human`, `reached` and `opt_outs` count in the group whose message that
  person received.
- **No conversions per group.** The tracker reports sales per stage, not per
  message — grade sales at stage level (`/stages`, `/campaigns/audit`).
- `pending_sends` above 0 means the stage is still sending and the groups will
  still shift. `opt_outs_complete` turns `true` once nothing is pending and 72
  hours have passed since the last send; until then late STOPs can still land.
- A manual-mode stage has no per-message tracking: `data: []`, `sent: 0`.
- `404` if the stage is not in that campaign; `400` if `groups` is not a whole
  number from 2 to 10.

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
- **`GET /api/campaigns/{campaignId}/stages/{stageId}/send-groups`** — the stage
  split into equal groups by send order (see Send groups, §3).
- **`GET /api/campaigns/{campaignId}/activity`** — timeline of what happened.
- **`GET /api/campaigns/{campaignId}/click-report`** — per stage: raw click events
  by class (`raw`, `suspect`, `bot`, `prefetch`, `unknown`, `unscored`), `human`
  (scored human click events) and `clicks_human` (distinct human clickers, §7).
  Grade on `clicks_human`: raw clicks are about 91% bots.
- **`GET /api/offers/{offerId}/report`** — one offer across campaigns.

### Dashboard

- **`GET /api/dashboard/stats`** — headline totals, accepts a range.
- **`GET /api/dashboard/active-campaigns`**, **`/active-stages`**.

### Revenue per day — the tracker's daily sums

**`GET /api/dashboard/daily-activity?preset=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`**

One entry per ET day in the range (up to 92 days; without `preset` it returns
the last 7 days). `sales` and `revenue` are dated by the day the **conversion**
happened and come from the tracker — the daily sums to set against the
tracker's own report. The other fields (`stages_sent`, `sms_count`, `cost`,
`opt_outs`, `clickers`) are dated by the send day, and `clickers` there is the
stage's stored click count, not `clicks_human`.

```bash
curl -s "https://camman.vercel.app/api/dashboard/daily-activity?preset=custom&from=2026-09-07&to=2026-09-13" \
  -H "Authorization: Bearer $CAMMAN_TOKEN"
```

Real excerpt, one day: `{ "date": "2026-09-13", …, "revenue": 319, "sales": 4, … }`.

- If a stage's sales were also entered by hand, that stage-day takes the larger
  of the tracker count and the hand count. Archived stages are left out.
- `400` for a range over 92 days, or `from` after `to`.

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
  params. Carries the spam score where one is cached, and per-creative
  `metrics`: EPC, and CTR = counted clickers ÷ messages sent over 30 days
  (`ctr`), 7 days (`ctr_7d`) and all time (`ctr_lifetime`), each with its
  `sent*` / `ctr_clickers*` counts. CTR comes from an hourly snapshot and is
  `null` when nothing was sent. `delivered` is the receipt/import tally, not a
  send count. `used_campaigns` (on every row, even with `include_metrics=false`)
  is the number of distinct campaigns with a sent stage using the creative, all
  time — the campaigns `/usage` lists. Sortable with `sortBy=used_campaigns`.
  `metrics.sales` (30 days) and `metrics.sales_lifetime` (all time) count a
  stage's sales as max(manual tally, Keitaro conversions); `sales_cr` = `sales`
  ÷ counted clickers. Sort by all-time sales with `sortBy=sales_lifetime`.
- **`GET /api/creatives/{id}`** — one creative.
- **`GET /api/creatives/{id}/usage`** — every campaign, sending number and day it
  has already run on (see Creative usage, §3).
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
| `rpm` | Revenue per 1,000 messages sent: `revenue ÷ sent × 1000`, 2 decimals. `dimension=creative` rows and totals only. |

- **Percent units**, 2 decimals: `3.04` means 3.04%.
- **`null` means "cannot be computed", never zero** — a denominator of 0, or a row
  made up only of manual-mode stages (those have no per-recipient reach).
- **Grade on `clicks_human`.** Raw clicks are about 91% bots (only click-report
  shows them), and `clickers` on report rows is the tracker's landing-visit
  count, not a human-click count.
- **`reached` is not `redirects`.** `redirects` counts the tracker's clean offer
  click events; `reached` counts recipients. They run close (1,226 vs 1,115 over
  2026-09-07..13) but measure different things.
- **The per-event rates on the SCREENS use this same `clicks_human` denominator,
  and they can exceed 100%.** There is no per-event denominator anywhere — a
  `<Type> rate` is `events[key].n ÷ clicks_human`, the divisor `EPC` uses. The
  rescue that pulls an unscored click into `clicks_human` fires on purchase- or
  revenue-bearing conversions only, so a registrant whose click was never scored
  human is in the numerator and not the denominator. Like `click_to_reach_pct`,
  the ratio is **not clamped**, and a zero denominator gives `null`, never `0`.
  (The report tables head that column `Clicks` — unsuffixed since 2026-09-20,
  because the page's own date filter names the window; `clicks_human` is this
  API's alias for the same number. **The API field name is unchanged**: this was
  a header rename on two screens, not a contract change.)

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
- Which contacts are in a pool. `pools` returns counts only; no endpoint lists,
  exports or identifies the contacts behind a pool number.
- Anything that writes: creating or editing campaigns, stages, creatives or
  segments; approving, scheduling or sending; compliance controls; user
  management.
- Opt-out and clicker lists, the audit log, deletion requests, partner/drip
  reporting.

Doing any of the above means opening CamMan in a browser and doing it as
yourself.
