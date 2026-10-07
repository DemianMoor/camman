# Drip — Partner reporting & signed report links

_Last updated: 2026-10-07 (late-purchase reclassification completed → converted; journey funnel Total vs Today columns; Send cost / NET profit / ROI columns; Drip Phase 7, migrations 0171 / 0172; sales + revenue from the conversion ledger; conversion-events Phase 4 funnel note; drip-journeys now returns the funnel only)_

What a lead partner is shown about the leads they sent us, how it is priced, and
how they get to it without a CamMan account.

Full external user accounts are **out of scope** — partner access is a signed
report link and nothing else.

---

## 1. Grain: partner × interest tag × ET-day range

`lib/reporting/partner-report.ts` → `getPartnerReport(orgId, from, to, partnerKeyId?)`.

`from` / `to` are inclusive **ET calendar days** (`YYYY-MM-DD`).

### Two sources, because one cannot answer both halves

| half | source | why |
|---|---|---|
| intake | `lead_intake_daily` counters | a **landline lead has no contact, no journey and no stage_send** — G4 counts it at intake and discards it. "Leads received including landlines" can only come from a counter. |
| sends | `stage_sends`, reached through `drip_journeys` → `lead_events` | the only place a send exists |

This is why the report does **not** extend `getStageMetricsInRange()`: no
stage-grained helper can produce the landline count.

### ⚠️ The send join is one-row-per-send by construction

A contact can hold several journeys over time (a terminal state frees the
one-live-per-contact slot), so joining `stage_sends` to `drip_journeys` on
`(org, contact, campaign)` can match **more than one** journey and multiply every
send. That is exactly how the Offer Group Report came to report 904,926 sends
against a true 88,536.

The query uses `JOIN LATERAL (… ORDER BY routed_at DESC LIMIT 1)` — the single
most recent journey that had already started when the send was created.

### ⚠️ The key set is a UNION of both sources

Rows are keyed off `intake ∪ sends`, **not** one source with the other
`COALESCE`'d onto it. A `(partner, tag)` pair that exists in only one source is
otherwise silently dropped — which happened on real data: the pre-0171 counter
row sits under tag `''` while its sends carry `medicare`, and every send vanished
from the report.

### Sandbox

Excluded everywhere, on `lead_events.sandbox` rather than on the key (a key can
be flipped out of sandbox after leads have arrived under it). A sandbox key is
**absent** from the report, not present with zeroes.

---

## 2. Columns (ruling R2)

| column | notes |
|---|---|
| Leads received | **includes landlines** |
| Mobile / VoIP / Unknown / Landline | the line-type split; sums to leads received |
| Sent | `stage_sends.status = 'sent'` — the project-wide definition of "was messaged" |
| Send cost | **revenue-gated** (see §2a). Each sent message at its rate **plus each opt-out reply at the rate of the send it answered** — the stage cost model `rate × (sends + opt-outs)` from [lib/stages/total-cost.ts](../../lib/stages/total-cost.ts), at send grain |
| Delivered % | **`null`** when the provider reports no delivery receipts — see below |
| Clicks, CTR | clean clicks only (not bot/prefetch/suspect); CTR is `null` over zero sends |
| Opt-outs | via `opt_out_attributions` |
| Sales | counted PURCHASE events in `conversion_events` for the row's recipients — `purchasesBySendSelect()` in [lib/sale-attribution.ts](../../lib/sale-attribution.ts), i.e. `is_purchase` event types in status `pending`/`approved`. A recipient with two conversions is **two** sales (the old `sale_status IN ('lead','sale')` column kept only the latest); a rejected or unmapped conversion is **not** a sale |
| Lookup cost | see §3 |
| Revenue | **off by default**, per-key toggle `partner_keys.report_show_revenue`. **APPROVED conversions only** — a held (`pending`) payout is not partner revenue, and a rejected one was taken back |
| NET profit | **revenue-gated**. Revenue − (send cost + lookup cost); may be negative |
| ROI | **revenue-gated**, last column. NET profit ÷ (send cost + lookup cost), as %; **`null` (`—`) when that cost is 0**. The totals line recomputes it from the summed money (`profitAndRoi()` in [lib/reporting/partner-profit.ts](../../lib/reporting/partner-profit.ts)), never averages rows |

### 2a. Send cost, NET profit and ROI (added 2026-10-07)

**Visibility.** Internal `/reports/partners` always shows all three. On the signed
link they appear **only when the key's revenue toggle is on**, and are zeroed /
nulled **on the server** by `stripRevenueForPartner()` otherwise (§9). NET profit
and ROI are revenue arithmetic, so they would leak revenue. Send cost is our SMS
rate. A partner who sees revenue, NET profit and lookup cost can work it out as
revenue − NET − lookup cost anyway, so the owner tied it to the same toggle rather
than hiding a column that adds no privacy. The CSV export follows the same rules.

**Opt-out replies are in send cost.** Recon (2026-10-07): inbound STOP replies
*are* cost-tracked. The stage cost model bills each reply at the send's rate
(`campaign_stages.total_cost`, the reports rollup, the lifecycle report). The
partner report prices the **same distinct opt-out set its Opt-outs column
counts**. So with a single rate, send cost = rate × (Sent + Opt-outs), and you can
check a row by hand from its own columns.

**Rate.** `COALESCE(stage_sends.cost_per_sms, the number's current
provider_phones.cost_per_sms, 0)`. ⚠️ **Drip sends before 2026-10-07 have no
snapshot.** The drip inserts ([lib/drip/scheduler.ts](../../lib/drip/scheduler.ts),
[lib/drip/send-one.ts](../../lib/drip/send-one.ts)) wrote `provider_phone_id` but
not the `cost_per_sms` that `kickoff.ts` snapshots (0 of 8,169 prod drip rows had
one). They now snapshot it at insert. Older rows use **today's** rate. That is exact
where the rate never changed: campaign 1606 → pml/aca $84.88 = its stage
`total_cost`. It is wrong where the rate did change: campaign 994's stage 3060
implies $0.011, but phone 114 is now $0.0100, so 994 reads ~$0.005 low. There is
no rate-edit history to recover the old rate from, and the owner chose not to
backfill.

### ⚠️ null is not zero

`delivered_pct` is `null` when there are no receipts at all, and `ctr` is `null`
over zero sends. Both render as `—`. Printing `0%` would read as total failure
rather than as *not measured* — the same distinction the Delivery Report makes.
The CSV export writes an **empty cell**, never `0`, for the same reason.

---

## 3. Lookup cost — calibrated from the ledger (ruling R1)

`lib/reporting/lookup-rate.ts` → `getCalibratedLookupRate(days = 90)`.

```
rate        = Σ(balance_before − balance_after) ÷ Σ(processed)   over a trailing 90 ET days
attribution = lead_intake_daily.lookups_spent   per partner × tag
cost        = lookups × rate
```

Production at time of writing: **$0.001635** per lookup, from **$1,002.84** across
**613,494** lookups (15 batches, 2026-07-14 → 2026-08-24). Flat rate for
comparison: $0.0015.

### ⚠️ The per-batch delta is NEVER used for billing

Measured, not theoretical. Across the 15 batches carrying both balances the
implied rate ranges **$0.000000 – $0.005889** (0× – 3.9× the flat rate):

- **Small batches read as free.** 4 of 15 have delta `0.0000`, and they are
  exactly the `drip_intake` batches (1–2 lookups each). Invoicing a drip partner
  from the per-batch delta bills them **$0.00**.
- **Concurrent batches share a snapshot.** Two 2026-07-21 batches both recorded
  `balance_before = 524.5600`; three 2026-08-24 batches all recorded `52.4700`.
  The balance is one account figure, so overlapping batches each claim the whole
  window's movement or none of it.

In **aggregate** it is sound, which is why the ledger sets the *rate* and
`lookups_spent` does the *attribution* — the latter being the only attribution
available, since nothing ties an individual lookup to a partner.

### ⚠️ `actual_cost_usd` is not actual

It equals `est_cost_usd` in 15 of 15 rows. Nothing reads it.

### Fails toward the flat rate, never toward zero

A window with no batches, no balance snapshots, or a non-positive delta (a top-up
landing mid-window makes the balance *rise*) yields `source: "flat"`. A zero rate
would silently invoice every partner nothing — precisely the failure the
per-batch delta already exhibits.

### Recalibration cadence

Recomputed **on every report load**, over the trailing 90 days. No cron, no
table. The report always prints the rate and the window it came from so an
invoice can be checked by hand.

> **Open decision.** Because the window is *trailing*, re-opening last month's
> report next month can show a slightly different cost for the same period. If
> invoices must be byte-reproducible after the fact, the calibration window
> should be pinned to the reported period (or snapshotted at issue). Not changed
> here — it is a billing-semantics decision, not an implementation detail.

---

## 4. Signed report links (ruling R4)

`lib/reporting/partner-report-token.ts`, migration **0172**.

Public page: `app/partner-report/[token]/page.tsx` — `robots: { index: false }`.

| property | how |
|---|---|
| opaque | 24 random bytes, base64url. Not a JWT, not an HMAC. |
| hashed at rest | SHA-256; the plaintext is returned **once** at issue and is unrecoverable |
| revocable | one `UPDATE` clearing the hash |
| scoped | `resolveReportToken` returns `partnerKeyId`; every query filters by it. **The route never accepts a partner id**, so there is no parameter to tamper with. |
| expiring | optional `report_token_expires_at` |

### ⚠️ Why not a signed token

Revocation is the requirement that decides it. A signed token cannot be revoked
without a denylist — i.e. without the very database lookup that signing was
meant to avoid. So: opaque, resolved by lookup, revoked by `UPDATE`.

### ⚠️ Every failure mode returns null indistinguishably

Unknown token, revoked token, expired token, archived key, sandbox key — all
`null`, and the page renders one `notFound()`. The page cannot be used to probe
which tokens ever existed.

Revoking a link does **not** disable the partner key: intake keeps working.
Conversely, disabling the key kills its report link in the same action.

### Endpoints

- `POST /api/partner-keys/[keyId]/report-link` — issue or rotate (rotation
  invalidates the previous link; there is only ever one live link per key).
  Returns the plaintext **once**. Requires `partner_keys.manage`.
- `DELETE /api/partner-keys/[keyId]/report-link` — revoke.
- `GET /api/reports/partners?from&to` — the internal report. `campaigns.view`.

### ⚠️ The proxy exclusion is an exact path segment

`proxy.ts` excludes `partner-report/` — **the trailing slash is load-bearing.**
Without it, a bare `partner` also drops `/partners`, `/partner-keys` and
`/partner-reports` out of the middleware entirely: no session refresh, no
redirect, nothing failing.

The matcher's lookahead is **anchored at the path root**, so an exclusion can only
ever affect top-level paths — `/settings/partners` was never reachable from here.

`scripts/test-public-route-scope.ts` does not take anyone's word for that: it
diffs this branch's matcher against `origin/main`'s across every real page route
in the repo plus an adversarial prefix family, and asserts `/partner-report/*` is
the **only** path whose behaviour changed. It also constructs the widened
`partner` variant and asserts the diff catches it — a guard that cannot go red is
decoration.

---

## 5. The journey funnel (ruling R4)

`lib/drip/funnel.ts` → `getDripFunnel(orgId, campaignId)`, surfaced on the drip
campaign detail page via `/api/campaigns/[campaignId]/drip-journeys` (which returns only
`{ funnel }` since 2026-10-06 — the per-journey list moved to the CSV export at `./export`).

### ⚠️ Two shapes that do not add up to each other

| block | shape | sums to |
|---|---|---|
| **progression** — routed → sent → clicked → reached offer → converted | **nested / cumulative** (a converted journey is also counted as clicked) | nothing |
| **outcomes** — grouped on `(state, close_reason)` | **disjoint** (one journey has exactly one) | the routed total |

Reading progression as disjoint shows a funnel that loses nobody. The UI states
which is which on the page.

### ⚠️ There is no `Registered` step, and that is deliberate (2026-09-18)

Conversion-events Phase 4 inserted **Registered** into the behavioural tier scale
as tier 3 and moved the purchased **exit** to tier 4
([behavioral-lanes.md](behavioral-lanes.md)). The progression funnel gained **no
new row**; what moved is one threshold, in
[`lib/drip/funnel.ts`](../../lib/drip/funnel.ts):

| Row | Predicate | What changed |
|---|---|---|
| `clicked` | `COALESCE(t.tier, 0) >= 1` | unchanged |
| `reached offer` | `COALESCE(t.tier, 0) >= 2` | **unchanged on purpose** — a registrant (3) and a buyer (4) *did* reach the offer, and that is what a cumulative high-water funnel means |
| `converted` | `COALESCE(t.tier, 0) >= EXIT_TIER` (**4**, was 3) | a $0 REGISTRATION is no longer counted as a conversion |

So a registrant shows up under **reached offer** and not under **converted**,
which is the truth about them. The per-lane breakdown *does* name the new lane:
`laneLabel` renders `Registered lane` for a tier-3 lane.

⚠️ **`converted` can also be under-counted by a race**, independently of the
above: [`lib/drip/lifecycle-sweep.ts`](../../lib/drip/lifecycle-sweep.ts) runs
purchase → completed → expired on the pooled client with no enclosing
transaction, so a purchase landing *between* the first two passes closes that
journey as `completed` / `all_stages_sent` instead of `converted` / `purchased`.
Sub-second per campaign, costs a funnel bucket and never a contact — the journey
closes either way and no message differs. Phase 4 widened the window (before tier
4, a buyer with unsent children could not be closed by the completed pass at
all). **Repaired since 2026-10-07 by the reclassification pass below.**

### Late purchases reclassify `completed` → `converted` (2026-10-07)

The network reports a purchase hours after it happens, so a sequence often finishes
first: on campaign 1606, 18 of 19 buyers read `completed / all_stages_sent` and
"How they ended · Converted" read 1. `reclassifyCompletedJourneysOnPurchase`
([`lib/drip/lifecycle.ts`](../../lib/drip/lifecycle.ts)) now runs as the last pass
of every lifecycle sweep, per org:

- a `completed` journey (either close reason) whose lead has a counted purchase
  (`purchasedClause()`) becomes `converted / purchased`;
- **`closed_at` is kept**: the journey ended when it ended. The change is recorded
  in `reason.reclassified` = `{from_state, from_close_reason, at, trigger:
  "purchase_detected_after_close"}`;
- ⚠️ **`opted_out` is never reclassified**, even if a purchase lands later. Opt-out
  is the stronger terminal state, and relabelling would hide a STOP behind a sale.
  `expired` / `exited` are not touched either;
- the purchase must belong to the journey: `occurred_at >= routed_at`, and before
  the contact's next journey on the same campaign was routed (re-entry case);
- the sweep's org list includes `completed`, so a campaign with no live journeys
  left still gets its late purchases reclassified.

Result: "How they ended · Converted" tracks the buyer count as detections land.
The two can still differ for buyers who opted out, and briefly for a buyer whose
journey is still live until the next sweep closes it. Measured on prod: 5.9 ms per
org (hash semi-join).

### ⚠️ Grouped on `(state, close_reason)`, not `state` alone

`completed` covers two materially different endings:

| state / reason | meaning |
|---|---|
| `completed` / `all_stages_sent` | the sequence ran out for someone who engaged |
| `completed` / `unengaged` | the Ignored lane fired and nobody was listening |

Collapsing them throws away the one number that says whether the campaign is
talking to anyone.

### The tier comes from `campaignTierExpr`

Not a local re-derivation. The lanes, the click report and this funnel therefore
cannot disagree about what "clicked" means.

### Total vs Today columns (2026-10-07)

The funnel renders two aligned columns: **Total** (all-time, everything above,
unchanged) and **Today** (the current ET day, resets at midnight ET). `getDripFunnel`
returns `today` (same five keys as `progression`) and `today_count` on each outcome.

| Today row | counts | dated by |
|---|---|---|
| Routed | journeys | `drip_journeys.routed_at` |
| Sent | journeys whose **first** send was today | `drip_journeys.first_send_at` |
| Clicked | distinct contacts with a clean click (same classification filter as `campaignTierExpr`) | `clicks.clicked_at` |
| Reached offer | distinct contacts | `stage_sends.offer_reached_detected_at` (**detection**, not Keitaro's event time) |
| Converted | distinct contacts with a counted purchase (`purchasedClause`) | `conversion_events.created_at` (**detection**, not `occurred_at`) |
| each ending | journeys that entered it today | `drip_journeys.closed_at` |

- ⚠️ **Today is events, not a cohort.** A click today may belong to a journey routed
  last week, so the Today rows are not nested and **no %** is shown for them.
- ⚠️ **Detection time, not event time,** for reach and conversion: the network's
  lag is hours, so event time would keep changing a day's number after the day
  closed.
- **Live states (`routed`, `active`) are a snapshot.** `today_count` is `null` for
  them and the UI shows the count once, spanning both columns, marked `now`.
- Every bound is an ET-day **range** from `campaignDayBoundsUtc()`, never a
  functional predicate on the timestamp (same rule as the drip monitor).

---

## 6. The Ignored lane is terminal (ruling R4)

`closeJourneyUnengaged` in `lib/drip/lifecycle.ts`, called from
`lib/drip/followups.ts` **inside the lane's own transaction**.

When the tier-0 (Ignored) lane fires for a journey, the journey transitions to
`completed` / `unengaged` in the **same transaction as the lane send**.

- **Why same-transaction:** the Ignored lane is the last thing that contact will
  ever be sent — they did not click, did not reach the offer, did not buy, and
  the tier is high-water so they can never drop into a lower lane. Closing in a
  later pass would leave a window where the journey is live with nothing owed,
  and would hold the contact's one-live-journey slot against a campaign that has
  nothing left to say to them.
- **Idempotent:** guarded by `state IN ('routed','active')`, like every other
  close. A second call is a no-op.
- **A terminal state already set wins.** If STOP arrives in the same minute, the
  journey stays `opted_out` / `stop_received` — the compliance record is never
  relabelled `unengaged`.
- **Does NOT cancel pending sends**, unlike `closeJourneyOnOptOut` — the send
  that triggered the close is itself pending dispatch.

`close_reason` is free text (no CHECK), so `unengaged` needed no migration.

---

## 7. Tests

| script | asserts |
|---|---|
| `scripts/test-public-route-scope.ts` | the matcher differential + that it can go red |
| `scripts/test-drip-unengaged-close.ts` | **camman-v2 preview only**, fully rolled back — the close is atomic with the send, idempotent, never overrides another terminal state, cross-org safe, and keeps the two `completed` reasons apart |
| `scripts/drip-p7-proof.ts` | production, read-only except the token lifecycle on `internal-test` (issued → resolved → revoked). Every reported number is checked against a **separate hand-written query**, not against itself. |
| `scripts/partner-report-cost-proof.ts` | production, **read-only**. Send cost hand-checked against campaign 994's history (5 sent + 1 opt-out on phone 114 → $0.06), and every partner/tag checked against an independent counter-query. Also checks the NET/ROI arithmetic, and that the strip zeroes revenue, send cost and NET and nulls ROI on a **synthetic non-zero** row. 12/12 on 2026-10-07 |

---

## 8. Schema

Migration **0171** — `lead_intake_daily`:
- `interest_tag text NOT NULL DEFAULT ''`
- PK widened to `(org_id, partner_key_id, day_et, interest_tag)`
- index `lead_intake_daily_org_partner_tag_day_idx`, RLS enabled

Migration **0172** — `partner_keys`:
- `report_token_hash`, `report_token_issued_at`, `report_token_expires_at`
- `report_show_revenue boolean NOT NULL DEFAULT false`
- partial unique index on `report_token_hash WHERE NOT NULL`

Both ship **inert**: 0 links issued, revenue off on every key.

---

## 9. ⚠️ Revenue is stripped on the SERVER, not hidden by the component

`stripRevenueForPartner()` runs in `app/partner-report/[token]/page.tsx` before
the report reaches the view. Since 2026-10-07 it also zeroes `send_cost_usd` and
`net_profit_usd` and nulls `roi` (§2a).

`showRevenue: false` only stops the column being **rendered**. The value still
travels in the RSC payload and is readable from view-source. This was found in
the **live production smoke check** — `revenue_usd` was sitting in the HTML of a
page whose key has revenue switched off. It read `0` at the time, so nothing
leaked; the first drip conversion would have published our margin to the partner
with the UI still looking correct.

The regression assertion in `scripts/drip-p7-proof.ts` runs against a **synthetic
non-zero** row, because today's real revenue is `0` and would pass either way.

**General rule:** for a public surface, "don't show it" is a rendering decision
and "don't send it" is a security one. Only the second is a control.

---

## 10. Where the controls live (added 2026-10-01)

The P7 token APIs shipped in August with **no UI** — the feature was reachable
only by calling the endpoints directly. Entry points now:

| surface | where |
|---|---|
| Internal report | Sidebar → Reports → **By Partner**, the Reports tab strip, and a **Partner report** button on Settings → Partners |
| Generate / rotate a link | Settings → Partners, per key. The URL is shown **once** via `CopyableId`, the same contract as the intake secret |
| Revoke | Settings → Partners, per key, behind a confirmation |
| Revenue visibility | Settings → Partners, per key — `report_show_revenue`, off by default |

⚠️ **Generate is disabled on sandbox keys.** `resolveReportToken` requires
`status = 'active' AND sandbox = false`, so a link issued on a sandbox key
resolves to null and the public page 404s. The button states the precondition
rather than letting the operator find out from a dead URL.

⚠️ **The list API returns report-link STATE, never `report_token_hash`.** The
link is unrecoverable by design; shipping the hash to the browser would hand an
operator the one value worth attacking.

⚠️ **The URL is built server-side** from `lib/app-origin` (partner-facing host,
primary host as fallback) — never from the request `Host`, or an operator on a
preview deployment would hand a partner a link that dies with that deployment.
