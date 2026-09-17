# Multi-event conversions (registration + purchase) — Phase 0 recon

## Decisions (user, 2026-09-17)

1. **Event transport:**
   - Registration arrives as `status=registration`.
   - Purchases come via the existing Affise network #5 template (`status={status}`, `tid={transactionid}`, `payout={sum}`).
   - `event=` is dropped, with no prod test postback. The card's URLs are superseded; the user will confirm the advertiser's macros before go-live.
2. **Status mapping per network/offer:** Sweeply `lead` = approved, Everflow `sale` = approved, Affise `lead` = pending, `rejected` = rejected. An unknown network/status → NULL + alert, never a purchase.
3. **Revenue and EPC count approved only.** Pending revenue gets its own column (campaign + reports). Sweeply `lead` is backfilled as approved, so existing numbers are unchanged.
4. **Backfill source is Keitaro history.** The three corrections (+$715 per recipient, −$100 stage-day, 26 conv / $1,463 stage-known with no recipient) are documented fixes, not regressions. The verify script asserts against Keitaro and prints the deltas.
5. **Lane order:** Purchased (exit) > Registered > Reached offer > Clicked > Ignored. The tier CHECK is extended.
6. **The send-time purchase re-check is OUT** of this card. Membership stays fixed at materialization, the acceptance criterion is relaxed, and a separate card covers all lanes.
7. **Refunders keep today's behaviour:** they fall back to Clicked / Reached offer and never enter Registered.
8. **Bugs and scope:**
   - All three live bugs are fixed in this card: 1 and 3 by design, 2 in its own PR (keyed by tid/event_id, not date).
   - Minimum drip changes only; no Registered follow-ups.
   - Add `offers.keitaro_offer_id`, and map Psycho Book 134 ↔ 41 at go-live.

Phase 1 plan: [plans/2026-09-17-conversion-events-phase1.md](../plans/2026-09-17-conversion-events-phase1.md).

---

**Read at:** `origin/main` `39f2b4d` (detached worktree `.claude/worktrees/conv-events-recon`), 2026-09-17.
**Live probes:** Keitaro Admin API (read-only: `conversions/log`, `conversion_types`, `affiliate_networks`, `offers`) and prod DB `rtdarhkkjwcetlmruftl` (read-only SELECTs). Nothing was written anywhere.

---

## Q1 — How conversions are ingested today

Two independent pollers read the **same** Keitaro endpoint, `POST /admin_api/v1/conversions/log`, filtered `status IN_LIST [lead, sale, rejected]` (`lib/keitaro/client.ts:162,197-199`). Columns requested: `event_id, sub_id_1, sub_id_3, status, revenue, datetime, click_datetime` (`client.ts:149-157`). **`tid` is not read. Neither are `params` or `conversion_type`.**

| Poller | Cron | Grain | Writes |
|---|---|---|---|
| `lib/keitaro/poll-conversions.ts` → `/api/keitaro/poll-conversions` | `9,24,39,54 * * * *`, 7-day window | **per recipient**: `sub_id_1` = `stage_sends.id` | `stage_sends.sale_status`, `sale_revenue`, `converted_at`, `converted_detected_at`, `keitaro_conversion_id` (`poll-conversions.ts:231-246`) |
| `lib/keitaro/poll.ts` → `/api/keitaro/poll` | `*/5`, **3-day** window | **per stage-day**: `sub_id_3` = stage `tracking_id`, dated by the conversion's `datetime` | `keitaro_stage_results.sales` (+1 per row, **including `rejected`**), `checkouts` (+1 per `lead`), `revenue` (sum) (`poll.ts:225-234, 403-422`); copies `checkouts` to `campaign_stages.checkout_click_count` (`poll.ts:453-474`) |

Per-recipient model = **one conversion per recipient, latest `datetime` wins** (`poll-conversions.ts:142-179`). Dedup skips the write when the stored `keitaro_conversion_id` equals the latest row's `event_id` (`:213-217`).

Manual third source: `stage_manual_sales` / `campaign_stages.sales_count`; surfaces take `GREATEST(manual, KSR)` per stage (`lib/stage-results.ts:21-26`, `offer_report_campaign_econ` in 0128).

## Q2 — Does Keitaro keep custom postback params, and can we read them back?

**Measured (1,460 conversions = all history, 2026-06-15 → 2026-09-17):**

- The `conversions/log` 400 error prints the full `events` report definition. Valid conversion-level columns include **`tid`, `params`, `conversion_type`, `conversion_type_id`, `status_history`, `conversion_history.status`, `version`, `sign`**. `original_status`/`previous_status`/`conversion_id`/`postback_datetime` are *accepted but silently not returned*.
- **`params` returns the postback's query as JSON.** Keys seen: `subid, status, payout, currency, from, tid, sub_id_3` plus Keitaro-derived `created_at, sub_id, revenue, datetime`. Every key seen is a param Keitaro recognises. **No sample contains an unrecognised key, so whether `event=registration` would be stored is UNPROVEN.** Keitaro docs list postback params as a whitelist, and the docs research reads that as unknown keys being dropped (inference, not a quote).
- Keitaro has **native conversion types** (`GET /admin_api/v1/conversion_types`): `Sale`(1), `Lead`(2, values `["lead"]`), `Rejected`(3), `Trash`(4), **`Registration`(5, values `["reg","registration"]`)**, **`Deposit`(6, values `["dep","deposit"]`)**. `conversion_type` / `conversion_type_id` come back per conversion (today only `Lead|2` ×1,449, `Sale|1` ×11).
- An Affise network already exists in Keitaro: **#5 "Affise.com PsychoBook"**, offer **#41 "Psycho Book"** (created 2026-09-16). Its configured postback template is
  `…/postback?subid={sub1}&payout={sum}&status={status}&currency={currency}&lead_status=2%2C5&sale_status=1&rejected_status=3%2Crejected%2Ctrash&from=Affise.com&tid={transactionid}`
  — Affise **pending (2) and hold (5) → `lead`**, approved (1) → `sale`, declined (3) → `rejected`, one conversion per `tid`. This is the source of "lead = hold". **It is not the template in the card.**
- Other networks: Sweeply.pro hardcodes **`status=lead` for paid conversions** (no tid); Adcombo `status={status}&tid=…`; Everflow `status={status}&tid=…`.
- Affise macro names (Affise help center): payout is `{sum}`, transaction id is `{transactionid}`. `{amount}`, `{txn}`, `{advertiser}` in the card are not Affise macros. `event=` would be a literal string baked into a per-goal postback URL.

**Proposed fallback (recommended over `event=`):** carry the event in Keitaro's own **`status`**.
- Registration goal postback: `status=registration&tid={transactionid}&payout={sum}&currency={currency}&subid={sub1}`. That resolves to the built-in `Registration` type.
- Purchase goal postback: the existing network-5 template (`status={status}` + `lead_status/sale_status/rejected_status`), so pending/hold/approved/declined all flow through on one `tid`.
- CamMan resolves `event_type` from `offer_event_mappings` keyed on **(offer, Keitaro status / conversion_type)**, and maps conversion status (pending/approved/rejected) **per offer**.
- **Go-live safety:** a `status=registration` conversion is **already excluded** by both current pollers' `IN_LIST [lead, sale, rejected]` filter. An early postback cannot leak into Sales, the purchased tier, or EPC before the new code ships.
- `sub_id_N` is **not** usable: it overwrites the *click's* sub_id, so the purchase conversion would inherit it.
- A `tid` prefix is not viable: Affise transaction ids are opaque, and we don't control them.
- If `event=` is still preferred, one test postback on a test click proves whether it lands in `params`. That writes to the prod tracker and needs approval.

## Q3 — Two conversions on one click

- **Keitaro:** a different `tid` gives **two separate conversions** (docs). Same `tid` (or no tid) with a new status or payout **updates the same conversion in place**.
  - **Measured:** conversion `01a0a2bd…` (no tid) was re-posted 2026-09-17. Its `version` went 1→2, **`event_id` stayed the same**, `datetime` moved from 09-14 21:45 to 09-17 07:13 ET, and `status_history` stayed at one entry.
  - Today 0 of 1,460 clicks carry >1 conversion. 14 *recipients* have 2 conversions on 2 different clicks.
- **Our sync today with reg + purchase on one click:**
  - Aggregate poll: **both count as Sales** (+2 sales, +1 checkout if the registration is `lead`), revenue summed.
  - Per-recipient poll: **latest `datetime` wins, the other is dropped.**
    - Purchase later → row = purchase. Registration later (or re-posted later, since a re-post moves `datetime`) → row = `lead`, `sale_revenue` = 0. The purchase revenue is gone, but the contact still reads as purchased.
    - Registration alone as `status=lead` → **purchased**: tier 3, buyer in segment rules, drip journey closed as `purchased`, dropped from every lane, counted in partner-report sales and the EPC-monitor "buyers".
  - Registration as `status=registration` → invisible to both pollers (filtered out).

## Q4 — Every reader of sale_status / purchasedClause / revenue

Verdict = what a $0 registration arriving as `lead` would do. WRONG = counted as sale/purchase/buyer or changes targeting. REV-OK = KSR revenue (a $0 adds $0). REV-AT-RISK = `stage_sends.sale_revenue` (latest-wins can wipe the purchase). DILUTED = skews a ratio. PR = `stage_sends`, KSR = `keitaro_stage_results`, MAN = manual, CC = `counted_clickers`.

### Targeting
| file:line | what | src | verdict |
|---|---|---|---|
| `lib/sale-attribution.ts:29-31` | `purchasedClause()` = `sale_status IN ('lead','sale')` | PR | WRONG |
| `lib/campaign-tier.ts:67-74` | tier 3 converted | PR | WRONG |
| `lib/sends/recipients.ts:170-173, 211-215` | lane recipients: tier exact match + `<> 3` exit (kickoff `kickoff.ts:625-663`, preflight `preflight.ts:161-172`, breakdown `preflight-breakdown.ts:153-213`) | PR | WRONG |
| `lib/audience-snapshot.ts:1022-1024, 1057-1058` | `computeLaneAudienceCountsBatch` (lane-counts route `:134`) | PR | WRONG |
| `lib/stages/split-group.ts:341-411` (`:390` converted_excluded) | `previewSplitLanes` (split modal) | PR | WRONG |
| `lib/segment-rules-eval.ts:147-173` | `made_purchase`, `_for_brand`, `_for_offer` | PR | WRONG |
| `lib/drip/lifecycle.ts:94-112` | `closeJourneysOnPurchase` (via `lifecycle-sweep.ts:58` ← `drip/monitors.ts:134`) | PR | WRONG |
| `lib/drip/followups.ts:124,158-159,176-178` | follow-up tier match | PR | WRONG |
| `lib/drip/funnel.ts:95-106` (`:101` `tier >= 3`) | drip funnel "Converted" | PR | WRONG |
| `lib/audience/pools.ts:87-94, 139-147` | operator pools `converted = bool_or(converted_at IS NOT NULL)` (also counts rejected) | PR+CC | WRONG |

### EPC / revenue
| file:line | what | src | verdict |
|---|---|---|---|
| `lib/keitaro/funnel.ts:75-76, 112-129` | `withFunnelDerived` epc = revenue / counted clickers | KSR | REV-OK |
| `lib/reporting/stage-funnel.ts:180-181, 392-396` | stage metrics; feeds `/api/keitaro/reports` (`:127-128, 288-308, 342-362, 444-447`) and `keitaro/results` | KSR | REV-OK |
| `lib/reporting/performance-report.ts:144,146` | revenue | KSR | REV-OK |
| `lib/reporting/performance-report.ts:572,580,679-685` | by-group revenue split weighted on `converted_at IS NOT NULL` | PR | WRONG |
| `lib/reporting/performance-report.ts:799-800` | hourly sales/revenue on `converted_at` | PR | WRONG / REV-AT-RISK |
| `lib/reporting/creative-lifetime.ts:56-102` | operator_rollups lifetime creative rows | KSR+MAN+PR | revenue OK, sales WRONG |
| `lib/reporting/attribution.ts:66-150` | `salesRevenueTotals/ByDay` → dashboard stats/daily-activity/tiles | KSR+MAN | revenue OK, sales WRONG |
| `lib/creatives/metrics-cache.ts:96-117,144-145` | creatives EPC, sales_cr, sales_lifetime | KSR+MAN | revenue OK, sales WRONG |
| `lib/reporting/grading.ts:61-124, 404-492, 541-652` | tails / creative usage / campaign audit conversions | KSR | revenue OK, conversions WRONG |
| `app/api/campaigns/[campaignId]/stages/route.ts:354-366,388-398,433-439,454` | campaign page revenue/ROI, `keitaro_sales_count`, reach→sale grading | KSR+MAN | revenue OK, sales WRONG |
| `lib/reporting/partner-report.ts:118,143-144` | partner sales + revenue via `purchasedClause` (external page `app/partner-report/[token]/page.tsx:63-79`) | PR | WRONG / REV-AT-RISK |
| `lib/reporting/counted-clickers.ts:154-157,177-190` | Rule F rescue on `converted_at IS NOT NULL` (EPC denominator for every surface) | PR | DILUTED |
| `lib/reporting/rollup.ts:76-77,104-105,155-156` | `report_*_hour` (no readers, cron unscheduled) | PR | dormant |

### Matviews / views (latest defining migration)
| object | migration | reads | verdict |
|---|---|---|---|
| `offer_report_campaign_econ` (view) | `0128:68-165` (security_invoker re-set in 0132) | KSR sales/revenue, manual, CC | sales WRONG, revenue OK |
| `offer_report_org_summary_mv` | `0128:170-213` | econ view, CC | sales WRONG, revenue OK |
| `offer_report_offer_totals_mv` | `0132:193-277` | econ view + `attributable_revenue = SUM(sale_revenue)`, `attributable_sales = COUNT(converted_at)` | sales WRONG, attributable REV-AT-RISK |
| `offer_group_report_mv` | `0133:60-216` (`:89-90`) | `SUM(sale_revenue)`, `COUNT(converted_at)`, CC | sales WRONG, revenue REV-AT-RISK |
| `audience_report_group_totals_mv` | `0180:41-87` | sums `offer_group_report_mv` | inherits WRONG |
| `offer_report_tracked_campaigns` (view) | `0132:173-179` | scope only | unaffected |

No SQL function or trigger reads conversion columns.

### Telegram / monitors
| file:line | what | verdict |
|---|---|---|
| `lib/reporting/report-snapshot.ts:97-138` → `telegram-report-format.ts:31-58` → `app/api/cron/telegram-report/route.ts:104-129` | daily/hourly Sales, Revenue, ROI (KSR+MAN) | Sales WRONG, revenue OK |
| `lib/reporting/epc-monitors.ts:144-203, 222-232` | excluded-clicker conversion % + Rule F rescues (CC) | WRONG (false alerts) |
| `lib/drip/monitors.ts:134` | purchase close | WRONG |
| `lib/reporting/tracking-gap.ts` | visits/redirects only | unaffected |

### APIs / UI
- Operator-token routes exposing the above: `dashboard/stats`, `dashboard/daily-activity`, `reports/performance`, `reports/tails`, `reports/audience`, `offers/[offerId]/report`, `campaigns/[campaignId]/stages`, `campaigns/audit`, `creatives/list`, `creatives/[id]/usage`, `audience/pools` (`lib/authz/route-map.ts`).
- `app/api/campaigns/[campaignId]/activity/messages/route.ts:112-113,141-142` + `components/campaigns/campaign-activity-section.tsx:495-508`: raw `sale_status`/`sale_revenue` badge. A registration renders "lead · $0.00".
- Campaign page Sales/Revenue/ROI: `app/(protected)/campaigns/[id]/page.tsx:1257-1296, 1530-1538, 1871-1879`.

### Scripts that assert on these (must be kept green / updated)
`smoke-prod-purchase-rule`, `test-purchase-rules`, `verify-purchase-rule-definition`, `test-campaign-tier`, `test-drip-lifecycle`, `test-lane-preview-count`, `test-lane-send`, `test-lane-sibling-exclusion`, `test-recipients-lanes`, `test-offer-reach-rules`, `test-segment-intersect-and-optout`, `verify-campaign-level-split`, `verify-audience-pools`, `test-keitaro-visit-conversions`, `verify-keitaro-batch-update`, `verify-counted-clickers(-refresh)`, `verify-epc-denominator`, `verify-epc-convergence`, `verify-epc-surface-grains`, `verify-epc-monitors`, `verify-clickers-fallback`, `verify-creative-ctr`, `test-stage-funnel`, `test-performance-report`, `test-telegram-report-metrics`, `test-report-rollup`, `test-creative-metrics-cache`, `verify-creatives-sales`, `verify-creatives-lifetime`, `verify-creative-report`, `verify-operator-grading(-http)`, `verify-offer-group-attribution`, `test-offer-group-report(-helper)`, `verify-audience-report`.

## Q5 — Behavioural split and where a new lane fits

- **Tiers** (`lib/campaign-tier.ts:5-10,43-78`): `MAX` over a `UNION ALL` of integer literals. 0 ignored, 1 clean click, **2 reached offer**, 3 converted. Tier 3 is an **exit**, not a lane.
- **Lane registry:** `LANE_TIERS` = 0/1/2 (`lib/stages/behavioral-split.ts:50-54`); `DEFAULT_LANE_TIERS = [1,2]` (`:67`); `resolveLaneTiers` (`:75-97`, message hardcodes "0, 1, 2").
- **Stored column:** `campaign_stages.behavioral_tier`, **CHECK `IN (0,1,2)`** (`0071_stage_behavioral_lanes.sql:42`, `db/schema.ts:2200-2204`). There's no Zod enum.
- **Audience at send:** `stageRecipientsSql` exact match `coalesce(bt.tier,0) = lane tier` plus literal `<> 3` (`lib/sends/recipients.ts:211-215`), sibling exclusion "Block 3" (`:174-210`), live opt-outs (`:239-242`), carrier policy. Two duplicated copies must stay in step: `computeLaneAudienceCountsBatch` (`audience-snapshot.ts:1057-1058`) and `previewSplitLanes` (`split-group.ts:353,388-406`).
- **T−15 does NOT recompute lane membership.** `recomputeDueSplitGroups` (`split-group.ts:433-487`, from `send-preflight` cron) only writes `source_stage_ids`. Membership is read once, **at materialization** (`kickoff.ts:628-663`). Phase A materializes at `scheduled_at <= now` (`scheduled.ts:106-107`); manual Prepare / approve-send materialize earlier. **The drain re-checks only opt-outs and the 1-hour phone dedup** (`drain.ts:566-629`); there's no tier or purchase re-check.
  - **Measured, last 30 days: 382 of 382 lanes materialized >15 min before `scheduled_at`, all unslipped. p50 2.6 h early, p90 10.8 h.** So the card's "someone who purchases between setup and send drops out automatically" is false today, including for the existing converted exit.
- **skipped_empty:** `markLaneSkippedEmpty` (`split-group.ts:123-134`), set only from Phase A on `no_recipients` (`scheduled.ts:723-739`). Settle via `settleSplitGroup` / `settleCompletedSplitGroups`; alert via `sweepStuckSplitGroups`. `notifyLaneSkippedEmpty` names tiers with a hardcoded ternary (`split-group.ts:602-603`).
- **Label/colour maps for a new tier:**
  - `BEHAVIORAL_TIER_META` (`app/(protected)/campaigns/[id]/page.tsx:350-371`), plus the explainer, tooltip and modal copy (`:1805-1827, 2189, 2248-2333`)
  - `TIER_LABEL` (`split-group.ts:335-339`)
  - autopilot raw number (`sends/autopilot/page.tsx:200`)
  - drip: `followup-timing.ts:19-38`, `children.ts:24`, `funnel.ts:82-88`, `journey-funnel.tsx:29-35`, `drip-followup-children.tsx:93-118`
- **Drip interaction:**
  - `lifecycle.ts:171-183, 265-277` re-derives tiers 1–2 inline.
  - `followups.ts:125-138` needs a detection-timestamp branch per tier.
  - `funnel.ts:101` uses `>= 3`.
  - Renumbering converted touches all three even if Registered gets no follow-ups. Prod has 3 `drip_journeys` rows.
- **Fit:** because lanes match a high-water tier exactly, Registered must be numbered **above Reached offer**, or a contact who reached the offer and registered lands in Reached offer. Natural encoding is registered = 3, converted = 4. Converted is never stored, so only the CHECK widens to `0..3`. "Registered – not purchased" also needs a **"has any purchase event in any status"** exclusion (the refund rule), which is distinct from `purchasedClause`.

## Q6 — Backfill size and "lead = hold" offers

| source | rows | revenue |
|---|---|---|
| Keitaro `conversions/log`, all history (from 2026-06-15) | **1,460** (1,449 lead, 11 sale, **0 rejected**, 0 zero-payout) | **$98,095.00** |
| `stage_sends` (per recipient) | **1,420** (1,409 lead, 11 sale) | **$95,917.00** |
| `keitaro_stage_results` | 1,461 sales across 17,322 rows | **$98,195.00** |

- `stage_sends` − Keitaro = −40 conversions / −$2,178:
  - **$715**: 14 recipients' second conversions dropped by latest-wins
  - **$1,463**: 26 conversions with blank `sub_id_1` (pre-rollout clicks; stage-attributable via `sub_id_3`)
- KSR − Keitaro = +1 / **+$100**: one double count (see bug 2). All other 752 stages match per stage, apart from one conversion shown under a sibling stage of offer 126 (net 0).
- 1,375 distinct buyer contacts, 361 campaigns, 19 CamMan offers. Manual: 43 `stage_manual_sales` rows (99 sales).
- **Offers where `lead` currently means hold: none in existing data.** Sweeply (1,411 rows, 18 offers) hardcodes `status=lead` = paid; Secco/Everflow (9) sends `sale`. "Lead = hold" first appears with Psycho Book (Keitaro network 5; CamMan offer **134**, network "PsychoBook AstroAff", 0 conversions).
- **No CamMan ↔ Keitaro offer link exists.** `offers.offer_id` is a short code (`psb`) and Keitaro's is `41`, so a conversion with no resolvable stage can't be attributed to a CamMan offer. Today there are 0 such conversions.

## Pre-existing defects found (not fixed — recon only)

1. **Status updates never reach `stage_sends`.** Keitaro updates a conversion in place with the same `event_id`, and `poll-conversions.ts:214` skips on an unchanged `event_id`. A hold→approved or →rejected transition is dropped. Proven on `01a0a2bd…`: re-posted 09-17, and `stage_sends` still holds the 09-14 values. Harmless so far (0 rejections ever); Psycho Book is the first network whose template sends transitions.
2. **`keitaro_stage_results` double-counts re-dated conversions.** A re-post moves `datetime`; the 3-day window leaves the old day's row frozen. One case today: stage `143_123_091126_2_s2_c661` = 3 sales / $300 vs Keitaro 2 / $200.
3. **Latest-wins drops second conversions per recipient:** 14 recipients, $715.
4. **Rejected is inconsistent:** KSR `sales` and every `converted_at IS NOT NULL` reader count `rejected`; `purchasedClause` doesn't.
5. `stage_sends.converted_detected_at` is write-only; `PURCHASE_SALE_STATUSES` is unused.

## Card assumptions the recon contradicts

- **"Lane composition is recomputed in the T−15 preflight"**: no. Membership freezes at materialization, which for 382/382 recent lanes happened before T−15. Meeting the acceptance test ("purchases after setup, excluded at send") needs a **drain-time purchase re-check**.
- **"Revenue uses status = approved (or whatever current revenue uses)"**: current revenue counts **every** conversion, including hold (and rejected in KSR). It stays identical only if backfill maps each network's status to the right lifecycle state (Sweeply `lead` → approved).
- **"Backfill status mapped from current sale_status; verify to the cent"**: the two current revenue sources disagree ($98,195 KSR vs $95,917 per-recipient), and `stage_sends` is lossy. The backfill should come from Keitaro's log, with the three deltas above accepted as corrections.
- **"Lane precedence Purchased > Registered > Clicked > Ignored"**: omits the existing **Reached offer** tier.
- **Postback URLs:** the card's templates differ from the Affise template already configured in Keitaro, use non-Affise macro names, and rely on an `event=` param Keitaro may not store.
