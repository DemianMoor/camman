# Additional Reports — Recon & Proposed Design

**Status:** Recon only. No code, no migrations, no branches. Awaiting approval before Phase 1.
**Date:** 2026-07-19
**Scope:** Five reports over one shared metric set, grouped by five dimensions, fed by one pre-aggregated hourly-bucket rollup layer.

---

## 0. TL;DR (the decisions that shape everything)

1. **The rollup output is tiny.** All-time there are only **299 stages with sends** and **302 distinct (stage, hour) buckets**. The stage-grain fact table is ~**302 rows** all-time; the group-grain fact ~**2,024 rows**. The expensive part is *scanning* the ~967K sent rows to build it — not storing or reading it. Pre-aggregation is still the right call (mandated after the admin-pages incident), and it's cheap.
2. **Four of the five dimensions (number, offer, sequence, hourly) are functionally determined by the STAGE.** Only **by-group** needs the per-contact many-to-many junction. → Propose **two fact tables**: one at `(stage, hour)` grain feeding 4 reports, one at `(group, stage, hour)` grain feeding the group report.
3. **Sales/revenue and cost do NOT live at hour or group grain natively.** They live per-stage (cost) or per-stage-per-day (Keitaro aggregate). But **`stage_sends` carries per-recipient sale attribution** (`sale_revenue`, `converted_at`) which recovers ~93% of sales and lets us bucket sales by send-hour and group. This is the key enabler — and its ~7% gap vs the authoritative aggregate is **Open Question #2**.
4. **Late-arriving facts (clicks, opt-outs, offer-reaches, conversions trickle in over 3–7 days).** → Maintenance is a **bounded rolling-window UPSERT** (recompute buckets whose send-hour is within a ~14-day "unsettled" horizon), not a pure append-only watermark and not a full matview refresh. Reuses the proven Keitaro rolling-window pattern + `cron_locks` watermark + `withCronLease`.
5. **Provider/number display (addendum, §2b) is essentially free.** The sending number is functionally determined by the stage (**0 stages span >1 phone**; only **3 numbers used all-time**), so the provider/number key is already implied by Fact A's `(stage, hour)` grain and adds **zero rows**. It's already in the proposed schema (§4). Every faceted breakdown stays tiny (<1,000 rows).

---

## 1. Metric-by-metric source mapping

All line refs into [db/schema.ts](db/schema.ts) unless noted. The **attribution spine is `stage_sends`** — one row per recipient-message, `id` = the send token. Every metric can be tied back to a send row, which carries `org_id, campaign_id, stage_id, contact_id, sent_at`.

| Metric | Source (hourly-capable) | Bucket timestamp | Join to send/stage | Live counts today |
|---|---|---|---|---|
| **Total sent** | `stage_sends` where `status='sent'` (`:2336`) | `sent_at` (`:2391`) | direct (`stage_id`, `campaign_id`) | 967,281 sent / 1,008,689 total rows |
| **Opt-outs** | `opt_out_attributions` (`:931`) | `created_at` (STOP receipt time) | `stage_send_id`→send, or `stage_id` direct; unique `(opt_out_id, stage_id)` = no double-count | 23,350 |
| **Clickers** | internal `clicks` (`:2277`), clean = `classification='human' AND scored_at IS NOT NULL` | `clicked_at` (`:2287`) | `link_id`→`links.send_token` = `stage_sends.id` (`:2211`) | 376,263 raw clicks |
| **Offer redirects** | `stage_sends.offer_reached_at` (`:2382`) — per-recipient reach | `offer_reached_at` | direct on the send row | 2,599 |
| **Sales / revenue** | `stage_sends.sale_revenue` / `converted_at` (`:2371-2374`) — per-recipient | `converted_at` | direct on the send row | 295 sales / $20,982 |
| **Cost** | `campaign_stages.total_cost` (`:1621`) — per-stage lump | (allocate to send-hour) | `stage_id` | 274/299 stages costed |

**Important source subtleties:**

- **"Clickers" is ambiguous in the codebase.** There are two populations: the internal short-link clean-click log (`clicks`, 376K, per-send attributable, hour/group-capable) **vs.** the Keitaro landing-visit count mirrored onto `campaign_stages.click_count` (what the current `/reports` page shows). They are different numbers. This recon recommends **internal clean clicks** for these reports (attributable + hourly/group-capable) — see Open Question #8.
- **"Offer redirect" ≠ "click."** A click/visit is a hit on the tracking link (Keitaro `gk-lp-visits`); an offer redirect is proceeding past the landing page to the offer (a different Keitaro campaign). `visits ⊇ redirects`. Internally, redirect is surfaced per-recipient as `stage_sends.offer_reached_at` (only 2,599 all-time — small and Keitaro-sourced with a multi-day trickle).
- **Sales dating is conversion-day, not click-day** (the memory-noted fix; [lib/keitaro/poll.ts](lib/keitaro/poll.ts):352-364). Per-recipient `converted_at` is the conversion instant → correct for hour bucketing.
- **Never use `keitaro_stage_results.cost`** — it is always 0; the Reports route overwrites it with `campaign_stages.total_cost` ([app/api/keitaro/reports/route.ts](app/api/keitaro/reports/route.ts):131-134).

**Authoritative sales cross-check (why per-recipient is a *choice*, not free):**

| Source | Sales | Revenue | Grain | Hour/group-capable? |
|---|---|---|---|---|
| Per-recipient (`stage_sends`) | 295 | $20,982 | per recipient | ✅ yes |
| Keitaro aggregate (`keitaro_stage_results`) — what `/reports` shows | 319 | $22,324 | per stage/day | ❌ no |

Per-recipient recovers **92.5% of sales / 94% of revenue**. The ~7% gap = conversions with no matching `sub_id_1`, plus manual sales (never per-recipient). See Open Question #2.

---

## 2. Dimension → schema mapping

| # | Dimension | Group key | Join from `stage_sends` | Risk |
|---|---|---|---|---|
| 1 | **Sending number** | `provider_phones.phone_number` (`:568`); account = `provider_credentials` (`:333`, `.label` `:360`) | `stage_id`→`campaign_stages.provider_phone_id` (`:1573`) — **not on the send** | MEDIUM (see below) |
| 2 | **Offer** | `offers.id` (`:173`) | `campaign_id`→`campaigns.offer_id` (`:1432`) — on the campaign, not the stage | Low |
| 3 | **Sequence message** | candidates below | `stage_id`→`campaign_stages`→`creatives` | Interpretation needed |
| 4 | **Hourly** | ET hour of `sent_at` | direct | Low |
| 5 | **By group** | `contact_groups.id` (`:717`) | live `contact_id`→`contact_contact_groups` (`:1145`) | HIGH (fan-out) |

**#1 Sending number — better than the docs feared, but not durable.** The memory note says `provider_phone_id` is "rate-limit-only" and often NULL for TextHub. **Empirically, 0 of 299 sent stages have a NULL `provider_phone_id`** today — so the dimension *is* populated. But it lives on the *stage*, is mutable, and is **not snapshotted onto the send**. Editing a stage's phone after the fact silently rewrites historical per-number attribution. → Open Question #5 (snapshot column vs live resolution). Owning-account (`provider_credential_id`) resolves via `provider_phones.credential_id` (`:588`).

**#2 Offer — clean.** `campaigns.offer_id`. No `offer_id` on the stage. `creative_offers` is creative-eligibility only — **not** the reporting key. Distinct from the external Keitaro campaign concept.

**#3 Sequence message — needs your call.** Four candidate columns, semantically different:
- `campaign_stages.stage_number` (`:1564`) — the literal ladder rung L1/L2/L3 within a campaign. **Recommended primary.**
- `campaign_stages.behavioral_tier` (`:1689`, `{0=ignored,1=clicked,2=reached offer}`) — the send-time behavioral lane.
- `creatives.funnel_stage` (`:1323`, `start|clicked|checkout|ignored|unknown`) — creative's declared intent (a content tag, often `unknown`).
- `creatives.sequence_placement` (`:1322`) / `creative_id` — the specific creative.

→ Recommend grouping by **`stage_number`** as the primary "sequence message" axis, with `funnel_stage`/`creative_id` carried as secondary breakdowns. Confirm in Open Question #1.

**#5 By group — real fan-out, non-additive.** A sent recipient's group(s) come only from the live `contact_contact_groups` junction (892K rows; **neither `stage_sends` nor `campaign_audience_pool` records the group a contact came from**). Avg **1.34 groups/contact, max 6** → summing per-group metrics **overcounts the grand total by ~34%**. The existing `offer_group_report_mv` already accepts this exact over-count by design (counts a campaign fully in each targeted group). → Same policy: per-group numbers are truthful *per group*; the grand total must come from the stage-grain fact, never from summing groups. Open Question #4.

---

## 2b. Provider / Phone display (addendum, 2026-07-19)

**Requirement:** every report shows the provider + sending number used, styled like the existing **Provider / Phone** column on `/campaigns` ([app/(protected)/campaigns/page.tsx](app/(protected)/campaigns/page.tsx):540-578): a `size-2 rounded-full` colored dot (`sms_providers.color`, fallback `#64748B`) + provider name, with the number beneath in `font-mono text-xs` (short codes shown raw, else `formatPhoneInternational`). The existing column already collapses multi-value rows to "N providers" / "N numbers" — reuse that convention. Recommend extracting a small shared `<ProviderPhoneCell providers phones />` from that cell so all reports and the campaigns list stay in sync.

**Report #1 (By Number)** — this *is* the dimension; render each row's number in that style directly.

**Reports #2–#5** — a single row (offer / message / hour / group) can span multiple numbers. Treatment options: (a) expandable provider/number sub-breakdown per row, (b) provider/number filter above the table, (c) both.

**Cardinality (why the choice is unconstrained — all read-only, live):**

| Measure | Count |
|---|---|
| Distinct sending numbers used all-time | **3** |
| Distinct provider accounts (`credential_id`) used | **3** |
| Distinct vendors (`sms_provider_id`) used | **3** |
| Stages spanning >1 phone (number FD by stage?) | **0** ✅ |
| Faceted rows: number × offer × hour | 117 |
| Faceted rows: number × group × hour | 705 |

The number is **functionally determined by the stage** (0 multi-phone stages), and Fact A/B are already keyed at `(stage, …)` grain — so `provider_credential_id`, `provider_phone_id`, and `sms_provider_id` (already columns in the §4 schema) cost **zero extra rows**. Even fully faceted, every breakdown is <1,000 rows and, with only 3 numbers in play, a filter control is a 3-item list and any per-row sub-breakdown is ≤3 sub-rows.

**Recommendation: (c) both, storing the key on every rollup row (already in the schema).** Since the key is free and cardinality is trivial, implement a provider/number **filter above the table** (cheap, lets you scope any report to one number) *and* an **expandable per-row sub-breakdown** (collapsed rows show the campaigns-style "N numbers"; expand to the per-number split). This keeps report #1 and the #2–#5 breakdowns reading the exact same denormalized columns. No schema change beyond what §4 already proposes; the only durability caveat is the same as Open Question #5 — `provider_phone_id` is resolved from the (mutable) stage, so snapshotting it onto `stage_sends` at materialization also hardens this display against later stage edits.

## 3. Cost derivation

- Cost is **not per-send**. It is a per-stage lump: `campaign_stages.total_cost = cost_per_sms × (sends + opt_out_count)` ([lib/stages/total-cost.ts](lib/stages/total-cost.ts):36-80), where `cost_per_sms` = `provider_phones.cost_per_sms` (`:572`).
- **Flat rate — segment count does NOT affect cost.** `allow_multi_segment` is a send *gate* on `creatives` (`:1332`), not a cost multiplier. A 2–3 segment message billed 2×/3× by the carrier is **under-costed**; nothing stores segment-adjusted cost. Real per-message cost exists only in the Ahoi CDR feed (`your_cost`, [lib/sends/ahoi-cdr-poll.ts](lib/sends/ahoi-cdr-poll.ts)) but is ingested for *inbound* opt-out reconciliation only, never for outbound spend.
- **Allocation to hour/group:** since a stage ≈ one hour bucket (302 buckets / 299 stages), allocating `total_cost` proportionally by each bucket's/group's share of sends is near-lossless. Equivalent to `cost_per_sms × (sent + optouts) in bucket`.
- Caveats the rollup inherits: 25/299 stages have `$0`/no cost; multi-segment under-costing; `total_cost` is mutable if the phone rate changes. Fixing segment-aware cost is **out of scope** for this feature — flagged for a later card.

---

## 4. Proposed rollup schema

Two thin fact tables (real tables, UPSERT-maintained — **not** materialized views, because we need incremental in-place updates, not full refresh). EPC/profit/% **derived at read time, never stored**.

### Fact A — `report_stage_hour` (feeds reports #1, #2, #3, #4)

Grain: **one row per `(org_id, stage_id, bucket_start_utc)`**. ~302 rows all-time.

```
org_id                uuid        FK organizations
stage_id              uuid        FK campaign_stages
campaign_id           uuid        FK campaigns
bucket_start_utc      timestamptz -- UTC instant of the ET hour start (sargable read key)
bucket_date_et        date        -- ET calendar day  (for the hourly report's day filter)
bucket_hour_et        smallint    -- 0..23 ET          (for the hourly report's x-axis)
-- denormalized dimension keys, resolved from stage/campaign at build time:
offer_id              uuid        -- campaigns.offer_id
brand_id              uuid
provider_credential_id uuid       -- provider_phones.credential_id  (the "account")
provider_phone_id     uuid        -- the sending number
sms_provider_id       text        -- vendor (txh/txh2/ahi/…)
stage_number          int         -- sequence rung
behavioral_tier       smallint    -- send-time lane
funnel_stage          text        -- creative intent
creative_id           uuid
-- additive counters:
sent_count            int
opt_out_count         int
click_count           int         -- clean human clicks
offer_redirect_count  int
sales_count           int
revenue               numeric(12,4)
cost                  numeric(12,4)
-- housekeeping:
settled               boolean     -- true once past the trickle horizon (frozen)
refreshed_at          timestamptz
```

Indexes: `UNIQUE (org_id, stage_id, bucket_start_utc)` (UPSERT key); `(org_id, offer_id, bucket_start_utc)`; `(org_id, provider_phone_id, bucket_start_utc)`; `(org_id, stage_number)`; `(org_id, bucket_date_et)`. (At 302 rows these are near-cosmetic now but correct at the maturity target.)

### Fact B — `report_group_hour` (feeds report #5 only)

Grain: **one row per `(org_id, contact_group_id, stage_id, bucket_start_utc)`**. ~2,024 rows all-time. Same counter columns, fanned out via the live junction. **Documented as non-additive to the grand total.**

```
org_id, contact_group_id, stage_id, bucket_start_utc  -- (UNIQUE)
+ same denormalized dims + counters + housekeeping as Fact A
```

Indexes: `UNIQUE (org_id, contact_group_id, stage_id, bucket_start_utc)`; `(org_id, contact_group_id, bucket_start_utc)`.

### Read layer — five thin views/queries

| Report | Reads | Group by |
|---|---|---|
| 1. By sending number | Fact A | `provider_phone_id` (+ resolve number/account label) |
| 2. By offer | Fact A | `offer_id` |
| 3. By sequence message | Fact A | `stage_number` (primary) |
| 4. Hourly (one ET day) | Fact A | `bucket_hour_et` where `bucket_date_et = ?` |
| 5. By group | Fact B | `contact_group_id` |

Derived at read: `epc = revenue / NULLIF(click_count,0)` (or per redirect — confirm), `profit = revenue - cost`, and each `%` = `metric / NULLIF(sent_count,0)`.

**Bucketing basis decision:** attribute *engagement* (opt-out/click/redirect/sale/cost) back to the **send's hour** (the recipient's `sent_at` bucket), not the event's own hour. This makes every rate a batch rate ("of messages sent in hour H, X% opted out") and matches the offer-group report's send-attribution model. Confirm for the hourly report specifically — Open Question #3.

---

## 5. Maintenance strategy — recommendation

**Recommend: bounded rolling-window UPSERT under `withCronLease`, with a `cron_locks` watermark marking the frozen boundary.** This is a synthesis of the two proven precedents:

- **Not a pure append-only watermark** (like `propagateTrackedClickers`): our buckets are *updated in place* as clicks/opt-outs/sales trickle in for days after the send. A forward-only watermark on `sent_at` would miss late engagement.
- **Not a full matview refresh** (like `offer_group_report_mv`): that re-scans *all* base-table history every run against a fixed 300s ceiling — cost grows with total send volume forever.

**Mechanism (every ~15 min, alongside the existing pollers):**
1. `withCronLease("report-rollup", …)` — single-runner guard (advisory locks are unsafe through the :6543 pooler; use the `cron_locks` lease-row pattern, [lib/cron/lease.ts](lib/cron/lease.ts)).
2. Read `cron_locks.watermark` = the newest `sent_at` hour already **settled**.
3. Define the **unsettled window** = send-hours in `(now − 14 days, now]`. 14d safely covers every trickle horizon: opt-out attribution 72h, offer-reach/conversion Keitaro window 7d. Only these buckets can still change.
4. Recompute the unsettled buckets from base tables and `UPSERT` into Fact A + Fact B (ON CONFLICT DO UPDATE on the unique key — same idempotent re-clobber the Keitaro poll uses).
5. Mark buckets older than the horizon `settled = true` and advance the watermark **after commit** in the same transaction.

**Cost:** the recompute scans ≤14 days of sends (today ~300K rows worst case; a few seconds) and writes a few hundred rows. `maxDuration = 60` is ample. Chunk the write (500-row statements, as the Keitaro poll does) so the pattern still holds at the millions-of-contacts target. Rejected alternative — per-row triggers on `stage_sends`/`clicks`/`opt_out_attributions` — because five hot base tables × trigger overhead on the highest-write paths (the send drain) is exactly the kind of coupling to avoid, and it can't attribute late Keitaro conversions that arrive via poll anyway.

---

## 6. Backfill sizing (estimates only — no backfill this session)

Current data spans **2026-06-03 → 2026-07-18 (~46 days)**, so "90-day" and "all-time" are identical *today*; "30-day" is roughly the last two-thirds.

| Depth | Fact A rows (out) | Fact B rows (out) | Base rows scanned | Est. runtime |
|---|---|---|---|---|
| 30 days | ~200 | ~1,300 | ~650K sends + ~250K clicks | seconds |
| 90 days / all-time | ~302 | ~2,024 | 967K sends + 376K clicks + 23K optouts + 2.6K reaches + 2.8K keitaro | seconds, one transaction |

**Output is trivial at every depth** (< 2,400 rows total). The only real cost is the base-table scan, which fits a single transaction well under 60s today. Build chunking (by ET day or stage batch) into the backfill script anyway so it survives the maturity target (100+ campaigns/day → a few hundred Fact-A rows/day, low-thousands Fact-B rows/day; the fact tables stay small, the scan is what grows → the rolling window keeps steady-state cheap).

---

## 7. Timezone handling

Confirmed ET end-to-end, reusing existing infrastructure ([lib/campaign-timezone.ts](lib/campaign-timezone.ts), `CAMPAIGN_TIMEZONE = "America/New_York"`).

- **Build (bounded, off the hot path):** `date_trunc('hour', sent_at AT TIME ZONE 'America/New_York')` to derive `bucket_start_utc` / `bucket_date_et` / `bucket_hour_et`. The non-sargable `AT TIME ZONE` cast only runs inside the rolling-window build, never in a hot read.
- **Read (hot path):** hits the pre-computed `bucket_*` columns directly — no timezone math, index-friendly.
- DST is handled by `AT TIME ZONE` (offset-aware); no manual offset arithmetic. Sends are already ET quiet-hours enforced, so hour buckets align with the send windows operators expect.

---

## 8. Open questions & risks

| # | Question / risk | Recommendation | Needs |
|---|---|---|---|
| 1 | **Sequence-message meaning:** ladder rung vs behavioral lane vs creative. | Group by `stage_number` (primary); carry `funnel_stage`/`creative_id` as secondary. | Confirm |
| 2 | **Sales source:** per-recipient (~93% of authoritative, hour/group-capable) vs Keitaro aggregate (authoritative, stage/day only). They won't match. | Use per-recipient consistently across all 5 reports for additivity; surface the reconciliation delta vs the aggregate. | Confirm tolerance |
| 3 | **Hourly attribution basis:** engagement bucketed to the *send* hour vs the *event* hour. | Send hour (batch rates). | Confirm for report #4 |
| 4 | **By-group non-additivity:** per-group sums exceed the true total by ~34% (max 6 groups/contact). | Accept (matches existing offer-group report); grand total comes from Fact A only, never from summing groups. Label clearly in UI. | Confirm |
| 5 | **Sending-number durability:** `provider_phone_id` is 100% populated on sent stages today but is mutable and not snapshotted onto the send — editing a stage rewrites history. | Snapshot `provider_phone_id` (+ `cost_per_sms`) onto `stage_sends` at materialization (small migration) for durable per-number + per-send cost. | Decide: snapshot column vs accept live-resolution risk |
| 6 | **Cost accuracy:** flat `cost_per_sms`; multi-segment messages under-costed; 25/299 stages uncosted. | Inherit as-is; segment-aware cost is a separate later card. | Acknowledge |
| 7 | **Clickers definition:** internal clean clicks (376K, attributable) vs Keitaro visits (what `/reports` shows). | Internal clean clicks. | Confirm |
| 8 | **EPC denominator:** revenue ÷ clicks vs ÷ redirects. | Clicks (clean). | Confirm |
| 9 | **Provider/number treatment for reports #2–#5** (§2b): (a) expandable sub-breakdown, (b) filter above table, (c) both. Key is free (0 row growth; only 3 numbers). | (c) both. Extract a shared `<ProviderPhoneCell>` from the campaigns column. | Confirm |

---

## 9. Reusable prior art (for the build phase)

- **Rollup read/schema shape:** [db/migrations/0093_offer_group_report.sql](db/migrations/0093_offer_group_report.sql), [lib/reporting/offer-group-report.ts](lib/reporting/offer-group-report.ts) — closest precedent (offer × group economics, list-pressure, fresh-pool).
- **Incremental maintenance:** [lib/links/propagate-clickers.ts](lib/links/propagate-clickers.ts) (watermark) + [lib/keitaro/poll.ts](lib/keitaro/poll.ts) (rolling-window UPSERT) — synthesize per §5.
- **Single-runner cron guard:** [lib/cron/lease.ts](lib/cron/lease.ts) (`withCronLease`), watermark column pattern in [db/migrations/0103_cron_locks.sql](db/migrations/0103_cron_locks.sql).
- **Metric SQL already written:** [lib/reporting/report-snapshot.ts](lib/reporting/report-snapshot.ts), [lib/reporting/attribution.ts](lib/reporting/attribution.ts) (max-dedup sales, ET-day scoping).
- **Cron registration:** [vercel.json](vercel.json); per-route `maxDuration`/`preferredRegion` exports.
- **Provider/Phone cell styling:** [app/(protected)/campaigns/page.tsx](app/(protected)/campaigns/page.tsx):540-578 — extract a shared `<ProviderPhoneCell>` for §2b.

---

**Stop point.** Awaiting approval on the design and Open Questions §8 before Phase 1 (schema + migration + backfill preflight).
