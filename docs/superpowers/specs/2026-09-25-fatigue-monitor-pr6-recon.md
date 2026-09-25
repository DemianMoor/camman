# PR 6 recon — the cohort fatigue monitor

_Recon only, no plan. Written 2026-09-25; figures read-only from production._

**The idea:** on top of PR 5's report, track weekly opt-out rate and click rate per lifecycle cohort. If **both worsen two weeks running**, raise the existing Telegram alert.

---

## 1. Where the weekly numbers come from

All three inputs exist and are already per-recipient.

| number | source | join |
|---|---|---|
| sends (the denominator) | `stage_sends` where `status='sent'` | — |
| cohort | `stage_send_lifecycle.status` | `stage_send_id` (PK) |
| opt-outs | `opt_out_attributions` | `stage_send_id` — **136,057 rows, 129,451 distinct sends** |
| clicks | `counted_clickers` | `(stage_id, contact_id)`, **not** `stage_send_id` |

⚠️ **Clicks join on (stage, contact), not on the send.** `counted_clickers` has no `stage_send_id`, so a contact messaged twice by one stage cannot have their clicks attributed to a particular send. For a weekly cohort rate that is harmless — the cohort is the same for both sends — but it rules out any later per-send click metric without a schema change.

PR 5's report already computes exactly these per cohort. **The monitor should read PR 5's query, not re-implement it**, or the alert and the page will eventually disagree about the same week, and the alert will be the one nobody checks.

## 2. ⚠️ The blocker: there is almost no cohort history yet

`stage_send_lifecycle` has been filling since **2026-09-24 13:30** — about 26 hours:

| cohort | stamped sends |
|---|---:|
| cold | 79,030 |
| new | 8,077 |
| freeze | 7,494 |
| hot | 6,014 |
| **warm** | **787** |
| suppressed | 0 (nobody has reached it) |

**"Two weeks in a row" needs three weeks of history to fire once.** Live stamping alone reaches that in mid-October. **PR 5's 60-day reconstruction is therefore a hard prerequisite**, not a nice-to-have — without it the monitor cannot produce a comparison for months, and worse, it would sit silently "ok" the whole time, which reads exactly like "nothing is wrong".

Whatever ships should refuse to evaluate a week it has no data for, rather than treating absent history as a passing check. See `feedback_guards_expire_on_correct_use` — a monitor that cannot fire is not a monitor.

## 3. How the alert would be sent

The path exists and already solves the hard part.

- `notifyOnTransition()` / `transitionAlert()` in [lib/alerts/alert-state.ts](../../lib/alerts/alert-state.ts) (migration 0154) gate on **state transition**, so a condition that persists pages **once**, not every tick. ⚠️ `notifyTelegram()` is stateless and best-effort by contract — calling it directly from a threshold check pages on every run for as long as the condition holds.
- It also carries a **pending** state (`firing` with `last_notified_at IS NULL`) so a failed delivery retries instead of being lost. Reuse it; do not hand-roll.
- `alert_state` holds **1,298 rows** with an established key convention: `contact-engagement-stale`, `heartbeat:conversion-events-ingest`, `tracking_gap:stage:2655`, `drip:numbers_exhausted:994`. A fatigue key would follow it — `fatigue:cohort:warm`, one row per cohort, so cohorts latch and clear independently.
- Cadence: weekly, after the week closes in ET. It should run on the existing cron surface rather than a new one.

## 4. ⭐ The threshold, and why the obvious one false-alarms

**The obvious rule — "rate went up two weeks running" — will page constantly on small cohorts.** An opt-out rate `p` over `n` sends has standard error `√(p(1−p)/n)`. At a realistic `p ≈ 0.5%`:

| n (sends in the cohort-week) | 1 SE | a "worsening" of ±2 SE is |
|---|---|---|
| 100,000 | 0.02 pp | ±0.04 pp — real |
| 10,000 | 0.07 pp | ±0.14 pp |
| **1,000** | **0.22 pp** | **±0.45 pp — pure noise** |
| 300 | 0.41 pp | ±0.8 pp — meaningless |

**warm is at 787 sends in 26 hours.** A quiet week puts it in the bottom row. Two consecutive noise draws in the same direction happen ~25% of the time by chance — per cohort, per week. Across 5 cohorts that is a false page most weeks.

Three things together make it sound, and all three are needed:

1. **A minimum denominator.** Below it the cohort-week is `insufficient_data` — a THIRD state, neither ok nor firing, and reported as such. Suggest ~5,000 sends, to be set from PR 5's real weekly distribution rather than guessed.
2. **A move that clears the noise floor**, not just any increase: require the change to exceed both a relative margin (e.g. +25% relative) **and** ~2 SE for that week's `n`. Small cohorts then need a genuinely large move, which is correct — that is what their data supports.
3. **Both signals, same direction.** Opt-out rate **up** and click rate **down**. Two weakly-related measures agreeing is much rarer than either alone, and it is also the thing "fatigue" actually means. This is the single biggest false-alarm reduction available and it is already in the card.

⚠️ **Count the cohort at SEND time, not now.** `stage_send_lifecycle.status` is the stamp; `contact_engagement.status` is today's value. Reading the live one would move contacts between cohorts retroactively and make last week's number change every time you look at it.

⚠️ **`suppressed` will always be 0 sends** — suppressed contacts are excluded from audiences by construction. It should be reported as structurally-empty, not as a cohort with a perfect record.

## 5. Open questions for the plan

1. The minimum denominator — set from PR 5's measured weekly distribution per cohort.
2. Is `Unclassified` (sends older than the backfill) a monitored cohort or excluded? Recommend excluded: its membership shrinks as the backfill extends, so its rates move for reasons unrelated to fatigue.
3. Does the alert name the cohort only, or carry the two rates and both weeks? Recommend the numbers — an alert that says "warm is worsening" without them just sends someone to the page to look up what the monitor already knew.
4. Manual clear, or auto-clear when the condition lifts? `clearAlert()` exists for both.
