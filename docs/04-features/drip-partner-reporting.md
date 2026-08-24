# Drip — Partner reporting & signed report links

_Last updated: 2026-08-24 (Drip Phase 7, migrations 0171 / 0172)_

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
| Delivered % | **`null`** when the provider reports no delivery receipts — see below |
| Clicks, CTR | clean clicks only (not bot/prefetch/suspect); CTR is `null` over zero sends |
| Opt-outs | via `opt_out_attributions` |
| Sales | `purchasedClause()` = `sale_status IN ('lead','sale')`, never `= 'sale'` |
| Lookup cost | see §3 |
| Revenue | **off by default**, per-key toggle `partner_keys.report_show_revenue` |

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
campaign detail page via `/api/campaigns/[campaignId]/drip-journeys`.

### ⚠️ Two shapes that do not add up to each other

| block | shape | sums to |
|---|---|---|
| **progression** — routed → sent → clicked → reached offer → converted | **nested / cumulative** (a converted journey is also counted as clicked) | nothing |
| **outcomes** — grouped on `(state, close_reason)` | **disjoint** (one journey has exactly one) | the routed total |

Reading progression as disjoint shows a funnel that loses nobody. The UI states
which is which on the page.

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
