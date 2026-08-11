# Feature — EPC denominator (counted clickers)

_Last updated: 2026-08-11_

## 1. Purpose

One definition of "click" for the whole platform, so every EPC on every screen divides by the same number, computed the same way.

Before 2026-08-11 the same campaign read differently depending on which page you opened. Campaign 404: **$1.0000** on `/creatives` and **$12.8049** on `/reports`. Both now read **$1.4247**.

## 2. The definition

A **counted clicker** is a contact who, within the grain being displayed, has:

- at least one click with `classification = 'human'`, **OR**
- a conversion (**Rule F**)

deduplicated at the grain of the row displayed.

Full precedence table — the definition, kept even where branches are currently unreachable:

| CamMan state | In Keitaro? | Counted? | Why |
|---|---|---|---|
| Scored `bot` / `prefetch` / `suspect` | either | No | CamMan scoring is authoritative |
| Scored `human` | either | Yes | Confirmed human |
| `unknown` (never scored) | Yes | Yes | Keitaro filtering vouches |
| `unknown` (never scored) | No | No | Nothing vouches |
| No CamMan row at all | Yes | Yes | CamMan missed it, or manual-mode |

Rows 3 and 4 are **unreachable today** — `clicks.classification` has had zero `unknown` rows across all history. Row 5 fires only for manual-mode campaigns.

**The consumer-relay carve-out is NOT applied at this layer.** It lives in the scorer ([datacenter-asns.ts](../../lib/links/datacenter-asns.ts)), so by the time a click reaches the denominator the rule has collapsed to `classification = 'human'`. That is the point of one definition of "human" in the codebase — do not re-implement the ASN logic in reporting.

### Manual-mode campaigns

They mint no links, so they have no per-recipient click rows and can never appear in the cache. Their denominator is Keitaro `visit_clicks_clean` instead, via `denominatorFor()`. The two are comparable in scale: only **11%** of Keitaro landing visitors are CamMan-excluded, so a Keitaro visit count lands close to what a counted-clicker count would be for the same traffic. Manual mode is 43 campaigns and **1.60%** of revenue.

## 3. ⚠️ Counted clickers are NOT additive

Not across grains, and not over time.

- One person tapping two creatives in one campaign is **one campaign clicker and two creative clickers**. Both are correct.
- One person clicking on two days is **one lifetime clicker, not two**.

Measured: per (campaign, contact) 54,494 · per (stage, contact) 68,431 · per (creative, contact) 68,419 · raw human taps 79,835.

Never sum counted-clicker counts — always re-aggregate from the membership. Per-stage and per-creative rows will sum to roughly **26% more** than the campaign total, and that is the correct behaviour, not a discrepancy. The UI shows the click count next to EPC on every surface so the grain is visible.

## 4. Storage — the cache stores the SET, not counts

`counted_clickers` (migration `0125`), one row per **(stage, contact)** counted clicker.

Storing membership rather than counts is what lets one table serve every grain and both time bases: because deduplicated counts are not additive over time, a per-day count cache could not produce a lifetime figure by summing.

| read | how |
|---|---|
| stage grain | `COUNT(*) GROUP BY stage_id` |
| campaign grain | `COUNT(DISTINCT contact_id) GROUP BY campaign_id` |
| creative grain | `COUNT(DISTINCT contact_id) GROUP BY creative_id` |
| lifetime | no date filter |
| period | filter `first_click_at` — which is also the click-date basis for period revenue |

`rescued_by_conversion` marks a row that exists only because the contact converted (Rule F).

## 5. Refresh — tied to the Keitaro poll

EPC is revenue ÷ counted clickers. Revenue advances every 5 minutes with the Keitaro poll. **If the denominator refreshed on an independent schedule, EPC would drift one way between rebuilds and snap back at each one** — an artifact indistinguishable from a real trend, on the platform's primary metric.

| pass | when | shape |
|---|---|---|
| incremental | inside every Keitaro poll tick (~5 min) | additive only, stateless 6h lookback, `ON CONFLICT DO NOTHING` (~6s) |
| full | daily 07:20 UTC (`/api/reports/rebuild-counted-clickers`) | wholesale rebuild — the repair path (~46s) |

Three load-bearing details:

- **No watermark, deliberately.** The lookback is a stateless window, not a stored cursor. `propagate-clickers` is watermark-incremental on `clicks.scored_at`; when the 2026-08-11 rescore corrected `classification` without touching `scored_at`, 4,312 rows fell behind its watermark and became permanently unreachable. A watermark makes a derived table silently un-repairable the moment its source is corrected.
- **The full pass uses `DELETE`, not `TRUNCATE`.** `TRUNCATE` takes `ACCESS EXCLUSIVE` and would block every EPC read for the length of the rebuild.
- **Autovacuum** is set to `scale_factor = 0.05` on the table (migration `0126`). Measured first: the incremental pass produces **zero** dead tuples (Postgres pre-checks the arbiter index on `ON CONFLICT DO NOTHING`), so all churn is the daily pass.

### Freshness is reported as two values

`getCountedClickersFreshness()` returns `updated_at` (either pass) and `full_rebuild_at` (the repair guarantee, up to 24h old by design). **Never collapse these into one "last updated" field** — a staleness indicator that overstates staleness gets ignored, and is then useless on the day it is telling the truth.

## 6. Call sites

All six, through one function. `withFunnelDerived` takes the denominator as a **required** parameter, which makes "no fallback to the old denominator" a compile-time guarantee rather than a convention.

| Surface | Code |
|---|---|
| `/reports` Overview | [`app/api/keitaro/reports/route.ts`](../../app/api/keitaro/reports/route.ts) |
| `/reports` By Number/Offer/Sequence/Group | [`lib/reporting/performance-report.ts`](../../lib/reporting/performance-report.ts) |
| `/offers/[id]/report` | matview `offer_report_campaign_econ` (migration `0126`) |
| `/creatives` list + stage picker | [`lib/creatives/metrics-cache.ts`](../../lib/creatives/metrics-cache.ts) |
| `GET /api/keitaro/results` | [`app/api/keitaro/results/route.ts`](../../app/api/keitaro/results/route.ts) |
| `/reports` Hourly | no EPC column — unchanged |

## 7. Lifetime vs period

**Lifetime EPC is the primary figure** and ignores the date filter entirely. Period EPC respects the selected range and attributes revenue by the **click's** date, not the sale's — otherwise numerator and denominator describe different populations. ~16% of sales shift to an earlier day under this basis; 100% of converted recipients have a recoverable click date.

## 8. Monitors ([`lib/reporting/epc-monitors.ts`](../../lib/reporting/epc-monitors.ts), weekly Mon 08:40 UTC)

The whole denominator rests on one signal — a click scoring `human`, which rests almost entirely on the datacenter-ASN check covering **91%** of taps. If that signal shifts, every click metric moves at once with no other warning. The 2026-08-11 incident took two months to notice.

| Monitor | Fires when |
|---|---|
| Human share of taps (monthly) | MoM move beyond ±30%, or share outside 3%–25%, with a 5,000-tap minimum |
| **Excluded-clicker conversion rate** | **> 0.1%** — bots do not buy |
| Rule F rescue count | > 2.5× the baseline of **8** |
| Precedence row-5 probe | any recipient reaching the offer with no CamMan click row |

**The human-share canary detects a CHANGE and would NOT have caught the Private Relay bug**, which never changed — it was baked in from the first click and the share was flat and wrong throughout. Catching a steady-state error about a subpopulation is the excluded-conversion monitor's job. They are complementary; neither covers the other.

Rule F is instrumented as a **detector**, not merely a correction: running silently it would mask the next scoring regression exactly as the last one was masked.

### Dead-man check

Alerting only on breach makes silence ambiguous — no message means healthy *or* "this stopped running in August". Each job records a heartbeat and checks **somebody else's**, because a dead job cannot report itself dead:

- the weekly monitors watch the daily rebuild (caught within a week)
- the daily rebuild watches the weekly monitors (caught within a day)

A NULL watermark counts as stale: never-run and stopped-running need the same attention.

## 9. Verification

| Script | Proves |
|---|---|
| [`verify-counted-clickers.ts`](../../scripts/verify-counted-clickers.ts) | the cache matches a **freshly recomputed** direct query (not a hardcoded constant, which goes stale within hours), Rule F invariant, non-additivity, idempotency |
| [`verify-epc-convergence.ts`](../../scripts/verify-epc-convergence.ts) | the old denominators disagreed on 12/12 top campaigns; the new one is single-valued across both screens |
| [`verify-epc-denominator.ts`](../../scripts/verify-epc-denominator.ts) | the reporting path end to end |
| [`verify-counted-clickers-refresh.ts`](../../scripts/verify-counted-clickers-refresh.ts) | incremental vs full semantics, including the self-healing guarantee |
| [`verify-epc-monitors.ts`](../../scripts/verify-epc-monitors.ts) | every threshold fires on synthetic series; heartbeats detect never-run |

⚠️ Run these on a pool with **more than one connection**. `getExcludedClickerConversion` holds a transaction; concurrent monitors on a `max:1` pool deadlock behind it.
