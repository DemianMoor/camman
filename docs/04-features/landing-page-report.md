# Feature — Landing Page Results (`/reports/landing-pages`)

_Last updated: 2026-10-23_

## 1. Purpose

Compare an offer's landing pages: one row for each page that received sends for the selected offer, plus a Total row. Pick the offer in a dropdown and a date range (custom From/To, or **All Time** = the offer's `created_at` day → today, which is the default).

| Piece | File |
|---|---|
| Page | [app/(protected)/reports/landing-pages/page.tsx](<../../app/(protected)/reports/landing-pages/page.tsx>) — a literal segment, so it wins over `[dimension]` |
| API | [app/api/reports/landing-pages/route.ts](../../app/api/reports/landing-pages/route.ts) — `GET ?offer_id=&from=&to=&split_brand=1`; without `offer_id` it returns the offer list. `campaigns.view`, `maxDuration = 60`, **no range cap** |
| Data | [lib/reporting/landing-page-report.ts](../../lib/reporting/landing-page-report.ts) `getLandingPageReport` |
| Table | [components/reports/landing-page-report.tsx](../../components/reports/landing-page-report.tsx) — hand-rolled like Delivery; ratios via `derive()` in [report-metrics.tsx](../../components/reports/report-metrics.tsx) |
| Sales % rule | [lib/reporting/landing-page-metrics.ts](../../lib/reporting/landing-page-metrics.ts) `salesPctOfReached` |
| Verify | [scripts/verify-lp-report-grains.ts](../../scripts/verify-lp-report-grains.ts) |

## 2. The landing-page key

A row is `(offer, slug)`, using the slug **as minted on sent rows**. Brands are merged by default, and a **Split by brand** toggle adds the campaign's brand to the key.

Resolution order:
1. **Minted.** The destination of a sent row's link (`stage_sends.link_id → links → link_destinations.url`), parsed as `/<landing_path>/<slug>`. `landing_path` is `lp` plus every brand's `landing_path`.
2. **Stage config.** `campaign_stages.landing_page_id → offer_landing_pages.slug`, else the page's `external_url` or the stage's `full_url`.
3. **Manual mode** mints nothing, so the declared `full_url` is used.

- A destination that is not slug-shaped becomes an **Unresolved row per host** (e.g. `lp.guidekn.com`, `blogcascade.com` for `/article/` pages).
- The title comes from `offer_landing_pages` on `(offer_id, slug)`. A slug that was sent but has no registry row is its own row labelled **not in registry** (offer 62: `kdtc`, `kcwv`).

Why "minted" and not `landing_page_id`: a page's slug is editable, and drip stages switch pages mid-flight. Keying on the page id would relabel history.
- **Slug edit:** stage 5510 sent to `bcf/sas`, but its page now reads `sas2`.
- **Mid-flight switch:** stage 5064 sent 8,927 to `mdc`, then 22,492 to `mdc2`.
- **Regular stages are unaffected today:** config and minted slugs agreed on every sent row (0 disagreements, recon 2026-10-23).

## 3. Send-date basis — two passes

Every figure belongs to the **sends made in the window**. A sale, click or opt-out that happened later still counts for the send that produced it. The page says "Send-date basis" next to the date picker. For a bounded window this legitimately differs from the Overview's default, which dates sales by conversion.

| | Regular stages | Drip stages |
|---|---|---|
| Grain | **stage** | **send** |
| In window | stage `sent_at` in range | `stage_sends.sent_at` in range |
| Sends | `sentCountsByStage` (rollup by send day + today live) — the Overview's hybrid; manual = `sms_count` | count of sent rows |
| Cost | `campaign_stages.total_cost` | `dripCostByStageInRange(…, { includeArchived: true })`, apportioned across a stage's pages by its sends' own cost |
| Sales / Revenue | ledger by `stage_id`: `purchasedClause` / `approvedRevenueClause`, + manual top-up `max(0, manual − ledger)` | ledger by `stage_send_id` |
| Opt-outs | `opt_out_attributions` by stage | by `stage_send_id` (the PR #25 breaker join) |
| Human clicks | `counted_clickers` of the stage | `counted_clickers` joined to the in-window send on (stage, contact) |
| Reached | `stage_sends.offer_reached_at` per stage (bounded on the partial index) | per send |

Why regular stages can be read whole:
- They send in minutes. Only 8 of 2,927 span two ET days, and 0.08% of sends fall off the stage's day.
- Their sends are still counted per send day from the rollup, so Sends foot to the Overview exactly.
- A stage dated outside the window but with sends on a day inside it contributes those sends only.

**Archived stages are included.** Archiving does not unsend, and the Overview already counts an archived stage's sends and revenue (they reach it through their tracker rows). As of 2026-10-23 there are 4 such stages, all drip on offer 152, with 44,881 sends — excluding them hid half that offer.

**Drip conversions without a `stage_send_id`** can't be placed on a page. They are counted in `unattributed_drip_conversions` and shown on the page, never silently dropped (0 as of 2026-10-23).

## 4. Columns

| Column | Definition |
|---|---|
| Sends | as above |
| RPM / Net RPM | revenue (− cost) ÷ sends × 1000 |
| EPC | revenue ÷ human clicks |
| **Human clicks (on sends in range)** | the standing denominator ([epc-denominator.md](epc-denominator.md)): `COUNT(DISTINCT contact_id)` at **(offer, slug)** for rows and at the **offer** for Total; clicked at any time. Manual stages add summed `visit_clicks_clean`, labelled `+manual` |
| **Click rate** | human clicks ÷ sends. Named apart from the Overview's `CR %`, which is landing visits ÷ sent |
| Sales | purchases only — **Upsell adds revenue, never a sale** |
| **Sales % (of reached)** | sales ÷ recipients who reached the offer page (`offer_reached_at`), **not** ÷ Keitaro redirects; over Keitaro-covered tracked stages only |
| Opt-out % | opt-outs replying to these sends ÷ sends |
| Net Profit | revenue − cost |

**Null, never 0.** A ratio with no denominator renders `—`. Sales % is `—` when a row has no Keitaro-covered stage: manual-only rows, and tracking-gap stages as defined by `hasNoKeitaroVisits` + `stageIsMatureForGap`, the same rule `shouldSubstituteClickers` uses. Clicks here are already `counted_clickers`, so there is no Keitaro visit count to substitute. The gap rule therefore only decides which stages Sales % may read.

**Total clicks do not foot**, by design — the UI says so. Measured all time: offer 62 shows 35,717 against a column sum of 36,498, and offer 123 shows 26,369 against 27,145. Every other column foots.

**Cost coverage.** `total_cost` is never NULL on a sent stage, but 376 regular stages show `$0` while having sends (13,151 sends, 2026-10-23). The page notes "cost $0 on N stages with sends" instead of hiding them; fixing them is a separate card.

## 5. Performance — measured on prod, 2026-10-23

Runs 2–3 were warm. A cold cache cannot be forced on the shared instance, so the cold column is each offer's first-ever All Time call that day.

| offer | window | sends | warm (ms) | first-ever (ms) |
|---|---|---|---|---|
| 62 | 7d / 30d / All Time | 0 / 2,689 / 1,643,153 | 316 / 338 / 476–627 | All Time 3,725 |
| 123 | 7d / 30d / All Time | 123,463 / 393,038 / 951,516 | 327 / 356 / 413–463 | All Time 1,300 |
| 152 (drip) | 7d / 30d / All Time | 52,917 / 85,879 / 85,879 | 731 / 1,030 / 919–1,047 | All Time 3,874 (excl. archived) |

Where the cold time goes:
- **Regular offers:** the one-sent-row-per-stage minted lookup.
- **Drip:** about 45 µs per send (sends → links → destination). At today's rate a single drip offer would reach the 60 s limit at roughly 1.3M drip sends. If that day comes, the answer is a per-(stage, day, page) rollup, not a range cap.

## 6. Verification

`npx tsx scripts/verify-lp-report-grains.ts` is read-only. Independent queries run inside `withReadOnlyDb`. Run it **without** `--conditions=react-server`: it imports `derive()` from a client component.

It covers offers 62, 123 and 152, plus the offer with the most upsell rows and the offer with the most manual stages — the last two chosen by data. Each runs × 7d / 30d / All Time.

- **(a)** Sends = Overview `getStageMetricsInRange` (conversion_date).
- **(a)** Cost = the same, except archived drip stages are re-priced per send. The Overview books an archived drip stage's lifetime `total_cost` on its first-send day, because `dripCostByStageInRange` skips archived stages for it. That differs only when the window cuts a stage's life (offer 152 7d: $15.01 vs $249.86).
- **(a)** Sales and Revenue:
  - regular = `keitaro_stage_results` + manual top-up per cohort stage, which is what the Overview's send_date basis sums;
  - drip = a per-send ledger recount.
- **(b)** Each row's clicks are recomputed with `COUNT(DISTINCT)` from `counted_clickers`. Total = offer-distinct, and Total ≤ column sum.
- **(c)** Every no-denominator cell is null, and at least one row with sends must render Sales % `—` — an unexercised check fails.
- **(12)** `purchasedClause` matches 0 upsell rows. Report Sales = ledger purchases + manual top-up, and Revenue includes upsell.
- **(d)** Scope is printed first; an empty scope fails.

Result 2026-10-23: **138 passed, 0 failed**.
