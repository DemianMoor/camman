# Keitaro tracking-gap monitor + Overview click fallback — design

**Date:** 2026-08-24
**Branch:** `feat/tracking-gap-monitor` (worktree `.claude/worktrees/tgap`, based on `origin/main`)
**Status:** approved design, ready for implementation plan

---

## 1. Problem

CamMan mints a tracked short link per recipient and records every tap in `clicks`.
Keitaro independently records a landing-page **visit** (via a script on the LP) and an
offer **redirect**. When the LP is missing the Keitaro visit script — or is dead — CamMan
keeps recording taps while `keitaro_stage_results.visit_clicks_raw/clean` stay at zero.

Nothing notices. Sends succeed, DLRs arrive, the Overview tab renders `Clickers 0`, and the
only symptom is a metric that silently reads zero.

### 1.1 Measured evidence (prod, 2026-08-24)

Tracked stages sent in the last 14 days, more than 6h ago, grouped by landing-page host:

| LP host | stages | CamMan human clicks | Keitaro visits (raw) | gap stages (visits=0, human≥25) |
|---|---|---|---|---|
| `www.guidekn.com` | 284 | 26,933 | 21,860 | **0** |
| `www.lumzen.co` | 6 | 881 | **0** | 5 |
| `www.fitsyou.net` | 1 | 11 | **0** | 0 |

The split is total and has no exceptions: `guidekn.com` carries the visit script,
`lumzen.co` and `fitsyou.net` do not. This is what the monitor must detect.

---

## 2. Recon: which CamMan figure corresponds to which Keitaro column

This is the load-bearing finding, and it **corrects the original brief**.

The brief proposed showing "the CamMan click count", exemplified as `2,277` for campaign 924.
That number traces to `count(DISTINCT links.contact_id)` over **all** clicks on stage 3029 —
unfiltered by bot classification.

Calibrated against the 284 healthy `guidekn.com` stages (the only cohort where both sides
are known good):

| Keitaro column | CamMan candidate | totals | ratio |
|---|---|---|---|
| `visit_clicks_raw` (21,860) | human click **rows** | 26,933 | **1.23x** OK |
| `visit_clicks_clean` (17,505) | `counted_clickers` | 23,569 | **1.35x** OK |
| `visit_clicks_clean` (17,505) | distinct contacts, **any** classification | 192,851 | **11.0x** WRONG |

The unfiltered figure is ~11x the Keitaro number it would replace. Rendering it would put an
11x-inflated count directly beside `counted_clickers` on the same row of the same table — the
failure mode recorded in the EPC-unification work, where an inflated benchmark made every
cell beat the average by construction.

**Resolution:** the brief's *structure* is right — raw ↔ total clicks, clean/unique ↔
distinct contacts — but both sides must be scoped to **human-classified** clicks.

`count(DISTINCT contact) FILTER (classification='human')` = 23,566 and `counted_clickers` =
23,569 differ by 3 rows (Rule-F conversion rescues). The spec uses `counted_clickers`: it is
the cached, platform-standard set every other surface already divides by.

### 2.1 Which columns actually reach a screen

| Column | Read by | Rendered? |
|---|---|---|
| `visit_clicks_raw` | `lib/keitaro/funnel.ts` tally, `lib/reporting/stage-funnel.ts` select | **No.** Diagnostic only — no UI, no API response field. |
| `visit_clicks_clean` | same, then `withFunnelDerived` -> `clickers` | **Yes** — "Clickers" column + StatCard, Overview tab |
| `redirect_clicks_raw` | tally | No |
| `redirect_clicks_clean` | tally -> `offer_redirect` | Yes (not in scope — redirects are not the gap) |

So exactly **one** displayed column needs a fallback, and it is the distinct-contacts one.
`visit_clicks_raw` needs no treatment because nothing shows it.

---

## 3. Part A — the monitor

### 3.1 Trigger

A stage breaches when **all** hold:

- campaign `link_mode = 'tracked'` (manual campaigns mint no links and have no CamMan clicks)
- `campaign_stages.archived_at IS NULL`
- `sent_at` between `now() - 7 days` and `now() - 6 hours`
- Keitaro **visits** for the stage: `sum(visit_clicks_raw + visit_clicks_clean) = 0`
- CamMan **human** clicks for the stage `>= 25`

The redirect count is **reported, not required**. The original brief required
`redirects = 0` too; measured against prod that would skip campaign 924 (visits 0,
redirects 101) and both `lumzen.co` stages of campaign 926 (redirects 4 and 11) — **3 of
the 5** stages that qualify, all of them the same defect. Visits are the signal; redirects
are context.

### 3.2 Thresholds and why

| Constant | Value | Reasoning |
|---|---|---|
| `TRACKING_GAP_MIN_HUMAN_CLICKS` | `25` | Human clicks run ~7.7% of all taps, so 25 is roughly a 3.5K-recipient send. At the brief's 100, a 10K send producing ~77 human clicks would stay silent. Over the trailing 7 days, 25 and 100 select the **same** 2 both-zero stages, so the lower bar costs no noise today while staying sensitive to medium sends. |
| `TRACKING_GAP_MATURITY_HOURS` | `6` | As briefed. The Keitaro poll runs `*/5`; 6h is far past any ingestion lag, so zero at 6h is evidence rather than latency. |
| `TRACKING_GAP_WINDOW_DAYS` | `7` | As briefed. Bounds the scan and stops long-dead stages re-alerting forever. |

The `25` threshold is calibrated on **human** clicks. Applying the brief's `100` to *total*
clicks instead would pull in the "Test Text Request" stage (152 taps / 21 human) — a test
campaign, i.e. exactly the noise that gets a monitor muted.

### 3.3 Expected fire set at implementation time

Five stages, all `lumzen.co`:

| stage | campaign | human clicks | visits | redirects |
|---|---|---|---|---|
| 3029 | 924 Wellaray WL_TR | 315 | 0 | 101 |
| 3044 | 923 Lulutox Manifestation | 145 | 0 | 0 |
| 3040 | 926 Lean Habit Jelly WL | 141 | 0 | 4 |
| 3041 | 926 Lean Habit Jelly WL | 137 | 0 | 11 |
| 3045 | 923 Lulutox Manifestation | 122 | 0 | 0 |

Stages below the bar and correctly silent: 2686 (21 human), 3018 (11), 2968 (7), 2665 (1),
2996 (1), 2897 (1).

### 3.4 Alert text

```
⚠️ Keitaro tracking gap
Stage {tracking_id} — {campaign_name}
CamMan recorded {clicks} clicks, but Keitaro shows 0 visits and {redirects} redirects since send ({sent_at}).
LP: {destination_url}
Likely cause: LP is missing the Keitaro visit script, or the LP is dead/404. Open the LP and check both.
```

`{redirects}` renders the literal count. When it is 0 the line is **byte-identical** to the
brief's verbatim text; it differs only when there is a nonzero number to report.

- `{clicks}` — human-classified click rows for the stage (315 for stage 3029, not 4,070).
- `{sent_at}` — rendered in ET via `formatCampaignDateTime`, per the project timezone rule.
- `{destination_url}` — the stage's most recent `link_destinations.url`.

One message per breaching stage.

### 3.5 Structure

**`lib/reporting/tracking-gap.ts`** (new)

- exports the three threshold constants with the calibration comments above
- `runTrackingGapMonitor(dbc)` — one SQL statement: candidate stages LEFT JOIN aggregated
  `keitaro_stage_results`, LEFT JOIN per-stage human click count, LEFT JOIN latest
  `link_destinations.url` (via `DISTINCT ON (links.stage_id) ... ORDER BY links.id DESC`)
- returns `{ window_days, maturity_hours, min_human_clicks, stages_evaluated, breaches }`
  where a breach carries `stage_id, tracking_id, campaign_name, human_clicks, redirects,
  sent_at, destination_url`
- pure decision helper `trackingGapBreached(humanClicks, visits)` kept separate so the rule
  is unit-testable without a database, mirroring `tells-monitors.ts`

**`app/api/cron/tracking-monitors/route.ts`** (new)

- auth mirrors `/api/cron/tells-monitors`: `CRON_SECRET` bearer, else `requireApiMembership`
  plus `can(role, "campaigns.view")`
- `export const dynamic = "force-dynamic"`, `export const maxDuration = 60`
- the check runs inside try/catch so a failure cannot take the route down
- per-stage latch via `notifyOnTransition` from `lib/alerts/alert-state.ts` with alert key
  `tracking_gap:stage:<stage_id>` — Telegram fires on the transition into `firing` only
- evaluated-and-clean stages get `clearAlert` with the same key, so a stage that regresses
  after a fix can alert again
- Telegram delivery wrapped in its own try/catch (a delivery failure must not fail the job)
- `recordHeartbeat` stamped **after** the work, so a run that threw does not look healthy
- returns the full report as JSON regardless of whether anything was sent

**`vercel.json`**: `{ "path": "/api/cron/tracking-monitors", "schedule": "37 * * * *" }` —
hourly, on a minute no existing cron uses.

### 3.6 No migration

`alert_state` (migration 0154) is already applied in prod and holds 3 rows. The latch needs
no schema change, no new table, and no backfill.

### 3.7 Latch lifecycle

Alert keys are per stage and permanent. A stage that ages past the 7-day window stops being
evaluated with its `alert_state` row left at `firing`; it is never re-evaluated, so it cannot
re-alert. This is intended — the row is a record that the human was told once.

---

## 4. Part B — Overview click fallback

### 4.1 Rule

Display-time only. No write to `keitaro_stage_results` — writing CamMan numbers into the
Keitaro sync table would poison the source and the next poll or repair pass would fight it.
A read-time rule covers every past period automatically and self-retires the moment visits
resume.

For a stage, substitute when **all** hold:

- campaign `link_mode = 'tracked'`
- `tally.visit_clicks_clean = 0`
- period `counted_clickers` for that stage `> 0`

Substituted value: the stage's period `counted_clickers` (`ClickerDenominators.periodByStage`).

### 4.2 Where

`app/api/keitaro/reports/route.ts`, immediately after `getStageMetricsInRange`, before the
campaign rollup and before the in-memory sort. Each stage gets a `clickers_is_fallback`
boolean carried onto the row.

Because the campaign rollup (`byCampaign` / `mergeFunnel`) and the grand totals both consume
the same per-stage tallies, campaign rows and the totals card inherit the substitution with
no extra code. A campaign or total row is marked when any stage under it fell back.

Sorting is in-memory and runs after row assembly, so the sort order matches what is displayed.

**Stage grain is deliberate.** The Keitaro column is itself assembled by summing per-stage
rows, so summing stage-grain `counted_clickers` matches how the number it replaces is built.
`periodByCampaign` is deduplicated at campaign grain and would *not* match — it would make a
fallback campaign row systematically smaller than a Keitaro one for the same traffic.

### 4.3 Scope boundaries

**In scope:** `/api/keitaro/reports` and `components/reports/keitaro-report.tsx` — the
Overview tab's "Clickers" column (campaign rows, expanded stage rows) and the "Clickers"
StatCard.

**Deliberately out of scope:**

| Surface | Why not |
|---|---|
| By Number / Offer / Sequence / Group tabs | Dimension rows aggregate many stages. `counted_clickers` is not additive across a dimension (measured overcount: By Number +38.6%, By Offer +27.2%). Mixing Keitaro visits for healthy stages with CamMan counts for gap stages inside one summed row produces a hybrid with no defensible grain. The brief scopes the fallback to stage/campaign. |
| `/campaigns/[id]` "Clickers" totals | Sourced from `campaign_stages.click_count`, a CSV-import counter, not `keitaro_stage_results`. Reads 0 for stage 3029 for an unrelated reason. |
| `/api/keitaro/results` | No UI consumer anywhere in the repo. |
| `lib/reporting/stage-funnel.ts` | Shared by all five report tabs. Patching here would silently change the four out-of-scope tabs. |

### 4.4 What must not change

`epc`, `counted_clickers`, `lifetime_epc` and `lifetime_clickers` all resolve through
`denominatorFor(link_mode, cached, keitaroVisitsClean)`. For **tracked** campaigns that
function reads the counted-clickers cache and never touches the tally, so patching
`visit_clicks_clean` cannot move them. For **manual** campaigns it *does* read the tally —
which is why the fallback is gated on `link_mode = 'tracked'`. Manual campaigns mint no
links, have no CamMan clicks, and can never satisfy the trigger anyway; the gate makes that
a structural guarantee rather than a coincidence.

Lanes and the `/clickers` entity are not on this code path at all.

### 4.5 Derived rates

`click_rate` (`clickers / sent`) and `redirect_rate` (`redirects / clickers`) both divide by
`visit_clicks_clean`. On a fallback row they render **`—` (unavailable)**, not a number.

Recomputing them against the CamMan denominator would create a hybrid rate — Keitaro
numerator over a CamMan denominator, biased about 26% low given the measured 1.35 ratio —
and a hybrid metric is not something a legend can honestly explain. Leaving them at `0%`
would be flatly wrong beside a non-zero Clickers figure. `—` states the truth: the Keitaro
denominator is missing, so the rate is not computable.

### 4.6 UI

- value renders as `282` followed by a superscript `*`
- `title="CamMan clicks — Keitaro visits unavailable"` on the cell
- one-line legend below the table: `* CamMan clicks — Keitaro visits unavailable for this period.`
- the same marker on the StatCard when any row in the range fell back

---

## 5. Verification criteria

| # | Check | Expected |
|---|---|---|
| 1 | Overview, campaign **924** / stage 3029, range covering 2026-08-22 | Clickers renders `282*`; CR% and Redirect% render `—` |
| 2 | Overview, any `guidekn.com` stage | byte-identical to pre-change response |
| 3 | `epc`, `counted_clickers`, `lifetime_epc`, `lifetime_clickers` on both rows | identical to pre-change response (assert on captured JSON) |
| 4 | By Number / Offer / Sequence / Group tab responses | identical to pre-change |
| 5 | `runTrackingGapMonitor` against prod, read-only | exactly stages 3029, 3044, 3040, 3041, 3045 |
| 6 | Second monitor run | zero Telegram sends (latch holds) |
| 7 | Clear one stage's `alert_state` row, re-run | that one stage alerts again |
| 8 | Alert body for stage 3044 (redirects=0) | byte-identical to the brief's verbatim text |
| 9 | `npx tsc --noEmit` and lint on changed files only | clean, compared against `git show HEAD:<file>` |

A verification script `scripts/verify-tracking-gap.ts` implements 5–8 and is re-runnable.

**Guard durability.** Checks 5 and 8 assert against today's world state, which expires the
moment the LP is fixed. The script must therefore also assert the durable invariant — *a
stage with zero Keitaro visits and >=25 human clicks is reported, and one with visits is
not* — proven by synthesizing both cases in a rolled-back transaction, so it can still go
red after the live gap closes.

---

## 6. Isolation and merge

Branch `feat/tracking-gap-monitor` in worktree `.claude/worktrees/tgap`, based on
`origin/main`, with `node_modules` junctioned and `.env.local` hard-linked.

Expected files:

```
lib/reporting/tracking-gap.ts                  (new)
app/api/cron/tracking-monitors/route.ts        (new)
scripts/verify-tracking-gap.ts                 (new)
vercel.json                                    (one cron entry)
app/api/keitaro/reports/route.ts               (fallback + flag)
components/reports/keitaro-report.tsx          (marker, legend, dash rates)
docs/04-features/tracking-attribution.md       (fallback rule + monitor)
docs/06-integrations.md                        (new cron)
docs/07-conventions.md                         (the raw/clean <-> CamMan mapping)
docs/CHANGELOG.md                              (one line)
```

Before merge: diff every touched file against the drip-campaign branch and rebase if
anything overlaps. Never overwrite parallel work.

---

## 7. Deliberately not built

- No migration, no new table, no backfill of `keitaro_stage_results`.
- No auto-remediation. The monitor detects; fixing the LP stays manual.
- No per-host alerting. The defect is host-scoped today, but a stage-grain latch is the
  honest grain — a second bad host would otherwise hide behind the first host's latch.
- No fallback on the four dimension report tabs (section 4.3).
