# Drip Phase 7 — recon: partner reporting + signed links + journey funnel

Card: [Drip P7](https://app.clickup.com/t/869endm3k) · parent [Drip Campaigns](https://app.clickup.com/t/869ency4b)
Date: 2026-08-24 · Status: **recon complete, awaiting rulings**

Everything below was measured against production or read from source.

> **Item 4 of the scope is already done.** The destination-picker fixes (the
> `%3F` tracking-ID artifact, Full URL population, the editable UTM flow, and
> migration 0170) merged as PRs #132/#133/#134 and are live.

---

## 1 — ⚠️ The lookup-cost ruling rests on a premise the data does not support

The Phase 0 ruling says: use `lookup_batches.balance_before_usd −
balance_after_usd`, **"ledger truth, not rate estimate"**. The intent is right —
you should not invoice a partner from a `DEFAULT_MOBILE_SHARE = 0.35` guess. But
the per-batch delta is not truth. All 15 batches that carry both balances:

| processed | delta | est | **delta ÷ lookup** | est ÷ lookup |
|---:|---:|---:|---:|---:|
| 1 | 0.0000 | 0.0015 | **0.000000** | 0.001500 |
| 2 | 0.0000 | 0.0030 | **0.000000** | 0.001500 |
| 1 | 0.0000 | 0.0015 | **0.000000** | 0.001500 |
| 5 | 0.0000 | 0.0075 | **0.000000** | 0.001500 |
| 212,767 | 21.29 | 319.15 | **0.000100** | 0.001500 |
| 19,646 | 27.07 | 29.47 | 0.001378 | 0.001500 |
| 33,654 | 50.53 | 50.48 | 0.001501 | 0.001500 |
| 144,164 | 221.62 | 216.25 | 0.001537 | 0.001500 |
| 40,511 | 95.67 | 60.77 | 0.002362 | 0.001500 |
| 19,642 | 47.77 | 29.46 | 0.002432 | 0.001500 |
| 73,230 | 431.25 | 109.85 | **0.005889** | 0.001500 |

Range: **$0.000000 to $0.005889 per lookup** — 0× to 3.9× the flat rate.

**Two distinct failure modes, both proven:**

**(a) Small batches read as free.** Four of fifteen have `delta = 0.0000`. Those
are exactly the `drip_intake` batches — 1–2 lookups each, which is *precisely
what drip produces*. A partner invoiced from the per-batch ledger would be billed
**$0.00** for their lookups.

**(b) Concurrent batches snapshot the same balance.** On 2026-07-21 two batches
both recorded `balance_before = 524.5600`; on 2026-08-24 three batches all
recorded `52.4700`. The balance is a **shared account figure**, so overlapping
batches each attribute the whole window's movement (or none of it) to themselves.
That is why one 07-21 batch reads 0.0001/lookup and the other 0.0059.

**⚠️ Also: `actual_cost_usd` is not actual.** It equals `est_cost_usd` in **15 of
15** rows. Anything reading that column name at face value is reading the
estimate.

**Where the ledger *is* sound — in aggregate.** Across all 15 batches:
`Σ delta = $1002.84` vs `Σ est = $920.24` over **613,494** lookups ⇒ an effective
**$0.001635/lookup** against the $0.0015 flat rate (+9%). Per ET day it is still
noisy (−8% to +29%), because other Telnyx spend lands in the same balance.

### Proposal (needs your ruling — R1)

Per-partner lookup cost = `lead_intake_daily.lookups_spent` **×** an effective
rate, where the rate is **calibrated from the ledger** over the reporting window
at org level (`Σ delta ÷ Σ processed`), falling back to the configured flat rate
when that window's delta is unusable (zero, negative, or absent). The report
shows the **org-level ledger total** beside the sum of partner lines so the two
can be reconciled.

This honours the ruling's intent — the ledger sets the *rate*, real per-partner
counters do the *attribution* — without pretending a per-batch delta is a
per-partner cost. Attribution by count is also the only option available:
**nothing ties a lookup to a partner.** `lookup_queue` is
`(id, batch_id, phone, status, attempts, last_error, created_at, updated_at,
priority)` — no partner, no lead.

---

## 2 — Which surface to extend

**The page/registry/tab pattern: yes.** `REPORT_DIMENSIONS` in
[lib/reporting/report-dimensions.ts](../../lib/reporting/report-dimensions.ts) is
a clean client-safe registry; `/reports/[dimension]` renders `PerformanceReport`
for all five. Adding a tab is a three-line change.

**The data helper: no, and this matters.** The five dimensions share
`getStageMetricsInRange()`, which is **stage-grained** and sourced from
`keitaro_stage_results` ⋈ `stage_sends`. It cannot answer the partner report's
first column:

> **A landline lead has no `stage_send`, no `contact`, and no journey.** G4 rules
> that landlines are counted at intake and then *discarded*. Nothing downstream
> of intake can count them, so no stage-grained helper can ever produce
> "leads received including landlines".

So Phase 7 is a **new helper at intake grain**, sharing the *conventions*
(window labels, null-not-zero, `purchasedClause()`) but not the query. The
send/click/sale half should still come from the existing shared helpers so the
numbers cannot drift from Overview — the card is explicit about this and the
Offer Group Report's `unnest` fan-out (904,926 vs a true 88,536) is the warning.

---

## 3 — Aggregate cost at 10–50K leads/day

**`lead_intake_daily` already exists** (migration 0157) and is already being
written — one live row today:

```
partner_key_id=15 day_et=2026-08-24 received=4 mobile=1 voip=3 unknown=0
landline=0 rejected=0 duplicate=0 sandbox=0 lookups_spent=4
```

Its columns are **exactly** the intake half of the report. Its grain is
`(partner_key_id, day_et)` — **one dimension short: no `interest_tag`.**

**What a live aggregate would cost.** `lead_events` carries the tag, and its only
useful index is `(org_id, partner_key_id, received_at DESC)`.

- **Internal report (all partners × tag × day)** cannot use that index's leading
  column, so a 30-day window at 50K/day is a **~1.5M-row scan and hash
  aggregate** on every page load. At 90-day retention the table is ~4.5M rows.
  Too slow for an interactive report.
- **Partner-facing report (one partner)** *can* use it — ~300K rows for a 30-day
  window at 10K/day/partner. Workable but not free.

| option | internal report | staleness | new infra |
|---|---|---|---|
| (a) add `interest_tag` to `lead_intake_daily` | **indexed read, ~rows = partners × tags × days** | none — written at intake | one migration |
| (b) matview + refresh cron | fast | minutes | table + cron + monitoring |
| (c) live aggregate | 1.5M-row scan/page | none | none |

**Recommendation: (a).** It is the counter-not-scan pattern the project already
uses, it stays exact because it is written in the intake transaction, and it is
the *only* option that keeps the landline count correct by construction.
Cardinality is trivial: 20 partners × 10 tags × 365 days ≈ 73K rows/year.

⚠️ Note (b) is not free precedent: `report_stage_hour` / `report_group_hour`
were built as rollups, the cron was **retired**, and the tables are dead. A
second rollup would want a reason the first one did not survive.

### Proposed migration 0171

```sql
ALTER TABLE lead_intake_daily ADD COLUMN interest_tag text NOT NULL DEFAULT '';
-- PK becomes (partner_key_id, day_et, interest_tag)
```
`''` rather than NULL so the PK stays usable (NULL never equals NULL in a unique
index, which would let duplicate untagged rows accumulate silently). The single
existing row backfills to `''`.

⚠️ Also worth fixing here: the current PK is `(partner_key_id, day_et)` with **no
`org_id`** — it is sound only because `partner_key_id` is globally unique, but it
is the one table in this feature that breaks the org-scoping convention.

---

## 4 — Signed-link token design (ruling: signed links, not accounts)

**Opaque random token resolved by DB lookup — NOT a self-contained HMAC/JWT.**

| | opaque + DB lookup | signed HMAC/JWT |
|---|---|---|
| revocation | **instant** — flip a row | needs a denylist, i.e. a DB lookup anyway |
| rotation | follows the partner key | re-sign + distribute |
| expiry | a column, checked live | baked in; clock skew |
| secret management | none | a signing key to store and rotate |

Revocation is the requirement that decides it: a signed token cannot be revoked
without the very lookup that makes signing pointless.

**Reuses the intake primitives** in
[lib/intake/partner-key.ts](../../lib/intake/partner-key.ts) — `generateToken()`
(24 random bytes, base64url), `hashSecret()` (SHA-256), `secretMatches()`
(constant-time). **The token is stored hashed**, exactly as the intake secret is,
so a database read cannot yield working report links.

- **Scope:** resolves to exactly one `partner_key_id`. Every query is filtered by
  it; the route never accepts a partner parameter from the URL.
- **Expiry:** nullable `expires_at`; NULL = no expiry. Checked on every request.
- **Revocation:** `status` on the row **and** the parent partner key's status —
  disabling the key kills its report link, per the ruling.
- **Route:** `app/p/[token]` — mirroring the existing public `app/r/[code]`.

⚠️ **Implementation constraint:** `proxy.ts`'s matcher must exclude the new
prefix. It currently excludes `r/` and `api/` only; without an exclusion a
public report page **307s to /login** before it ever routes, which is the exact
trap noted in the prod smoke-check work.

### Proposed partner column set (needs your ruling — R2)

| column | partner sees | why |
|---|---|---|
| leads received | ✅ | what they delivered |
| landline / mobile / voip / unknown | ✅ | explains the deduction |
| sent | ✅ | |
| delivered % | ✅ | only where the provider reports DLR — **null, not 0**, elsewhere |
| clicks, CTR | ✅ | |
| opt-outs | ✅ | quality signal they can act on |
| lookup cost | ✅ | the deduction, per period |
| **sales count** | ✅ | proves lead quality |
| **revenue** | ❌ default, per-key toggle | our margin, not theirs |
| campaign / offer / creative names | ❌ | our operation |
| interest tag | ✅ | it is their own routing dimension |

---

## 5 — Journey funnel (item 3)

`drip_journeys` already carries everything: `state` ∈ routed/active/opted_out/
converted/completed/expired/exited/unroutable, plus `first_stage_id`. The
per-stage grouping uses `drip_journeys_org_campaign_state_idx (org_id,
campaign_id, state)`. Clicked/offer come from `campaignTierExpr` — the same
helper the lanes use, so the funnel cannot disagree with the lanes.

⚠️ **`completed` will need splitting in the display.** Under the new
Ignored-terminal ruling, `completed` covers both "all lanes done" and
"unengaged". The reason is already carried in `close_reason`, so the funnel
should group on `(state, close_reason)` rather than `state` alone — otherwise
"completed (unengaged)" and "completed (all stages sent)" are one bar.

---

## 6 — Rulings needed before build

- **R1 — lookup cost.** Adopt the calibrated-rate proposal in §1, or keep the
  per-batch delta knowing it reads **$0.00** for every drip batch?
- **R2 — partner column set.** Confirm §4's table, especially revenue-off-by-default.
- **R3 — migration 0171.** Add `interest_tag` to `lead_intake_daily`'s PK
  (recommended), and take the chance to add `org_id` to it?
- **R4 — the Ignored-terminal ruling** needs `close_reason = 'unengaged'` as a
  distinct value; confirm the funnel groups on `(state, close_reason)`.
