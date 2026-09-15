# Creatives list — Sales CR fix + "Sales, qty (all time)" column (design)

_Date: 2026-09-15 · Status: approved by the user in-session_

## Problem

`/creatives` Sales CR reads 0.0% for every creative. `lib/creatives/metrics-cache.ts` sums `campaign_stages.sales_count` as the numerator. That column is only the operator's MANUAL tally: the Keitaro poll mirrors clicks and checkouts onto the stage but deliberately never sales (`lib/keitaro/poll.ts` — sales are added at read time by every other surface). On prod (2026-09-15) stages created in the last 30 days carry `sales_count` = 0 and 549 Keitaro conversions across 111 creatives.

## Decisions (user)

- Fix Sales CR; keep its denominator (counted clickers) and window (stages created in the last 30 days).
- New column **"Sales, qty (all time)"**: every sale the creative has produced, all time. Sortable server-side.

## Definition

Per stage, effective sales = `greatest(campaign_stages.sales_count, Σ keitaro_stage_results.sales)` — the `combineSales` rule in `lib/stage-results.ts` (max, not sum: a sale in both sources is one sale). Summed per creative:

- `sales` (30d) over stages with `created_at >= now() - 30 days` — Sales CR numerator.
- `sales_lifetime` over all the creative's stages.

On this account Keitaro conversions are the network's `lead` postbacks, so this is the same Sales every report shows. Prod today: 549 (30d, 111 creatives), 1,522 all time (196 creatives); summing instead of max would double-count 11 sales on 10 stages.

## Approach

In `computeCreativeMetrics`, aggregate `keitaro_stage_results` once per stage (org-scoped CTE) and LEFT JOIN it into `stage_agg` and `stage_life`, replacing the per-stage correlated revenue subqueries. Sales and revenue come from the same pass. Measured on prod: stage part 1,535 ms / 343,794 buffers → 17 ms / 991 buffers. Revenue (EPC numerator) must be unchanged.

## Changes

- `lib/creatives/metrics-cache.ts`: per-stage Keitaro CTE; `sales` = Σ greatest(manual, keitaro) for 30d stages; new `lifetime_sales` field.
- `app/api/creatives/list/route.ts`: `lifetime_sales` in the jsonb recordset + select; response `metrics.sales_lifetime`; `sortBy=sales_lifetime` (requires metrics, like the ratio sorts).
- `app/(protected)/creatives/page.tsx`: type + "Sales, qty (all time)" column after "Clicks (all time)", sortable, tooltip.
- Docs: `docs/04-features/campaigns-stages-creatives.md`, `docs/operator-api.md` §6, `docs/07-conventions.md` (never read `sales_count` alone), `docs/CHANGELOG.md`. No migration.

## Out of scope

Sales CR denominator; reports; stage creative picker; `lib/dashboard-stages.ts` (its `sales_count > 0` is one OR'd "has results" predicate — Keitaro-sales stages also carry mirrored clicks, so no visible gap).

## Verification

1. Script: for every creative, `metrics.sales` and `metrics.sales_lifetime` equal an independent recount (stage rows and Keitaro rows fetched separately, max per stage in JS); `sales_cr` = sales / clean_clicks; `payout` and `epc_lifetime` equal an independent revenue recount; ≥1 creative has Sales CR > 0; `sortBy=sales_lifetime` ordered with id tiebreak. Keitaro rows change every 5 min, so recounts are taken before and after the cache fill and moved creatives are reported, not compared.
2. `tsc`, eslint on changed files (no new problems), `check:docs`.
3. Playwright on `/creatives`: Sales CR non-zero, new column + sort.
4. After merge: prod READY + smoke.
