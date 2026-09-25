# PR 5 recon — Lifecycle report tab + 60-day reconstruction

_Recon only. No plan yet; written 2026-09-25, all figures read-only from production._

## The headline: the reconstruction cannot read `contact_engagement`, and cannot replay transitions either

The spec (§10) says each sent row's status is "reconstructed from the facts as of `sent_at` … using current thresholds". Both obvious sources are unavailable for that:

- **`contact_engagement` holds only CURRENT rollups.** `msgs_total`, `msgs_7d/14d/30d/90d`, `last_sent_at`, `last_click_at` are point-in-time *now* values. They cannot say what `msgs_total` was on 2026-08-13.
- **`contact_engagement_transitions` starts at 2026-09-23 09:19:51** — the backfill instant. There is no history to replay for any send older than that, which is **every row the reconstruction targets**.

So the reconstruction must **replay the raw facts**: per contact, the send and click history up to each `sent_at`, then run `evaluationSelectSql` against those as-of counts. The raw material exists — oldest send is **2026-06-03**, comfortably past the 60-day window.

⚠️ **This makes PR 5's backfill a fundamentally heavier job than PR 1's.** PR 1's backfill read current rollups and wrote a status per contact. This one computes a *different* as-of state per (contact, day) and writes one row per SEND. Sizing below.

## Size

| | |
|---|---|
| sent rows in the last 60 days | **3,884,291** |
| of those, unstamped (the reconstruction's target) | **3,782,889** |
| distinct ET days | **54** |
| busiest ET day | 2026-08-13 — **106,174** sends |
| next busiest | 104,079 · 104,034 · 100,787 · 100,753 |

At ~100K sends/day for the top days, the per-day batch the spec calls for is a real unit of work, not a formality.

## Live stamping is already working

`stage_send_lifecycle`: **120,660 rows**, **0 reconstructed**, oldest stamp 2026-09-24 10:13 UTC, newest 2026-09-25 17:27. So the Prepare-time stamp shipped in PR 2b is doing its job, and the reconstruction only has to cover what precedes it. The `reconstructed` flag is in place and unused, ready for the UI's "this period includes reconstructed rows" marker.

## The report's per-recipient joins

| source | rows reaching a send | note |
|---|---|---|
| `counted_clickers` | 164,755 total | joined on (stage, contact), not `stage_send_id` — no `created_at` column, so period filtering goes through the send |
| `opt_out_attributions` | **136,015** with `stage_send_id` | joins directly |
| `conversion_events` | **1,527** with `stage_send_id` | ⚠️ tiny relative to sends |

⚠️ **Sales and revenue per cohort will be extremely thin.** Only 1,527 ledger rows carry a `stage_send_id` at all. The spec's CR (sales ÷ human clickers) and revenue columns will be near-empty for most periods, and the existing footnote about per-recipient numbers not matching Overview understates it. Worth deciding before building whether those two columns ship, ship with an explicit "attributed only" label, or wait.

## Open questions the plan will have to answer

1. **Is the as-of replay affordable?** Needs a measurement of reconstructing ONE mid-size ET day, end to end. **Not run yet** — it is a multi-GB read and the heavy-verification convention puts that in the ~05:00–06:00 UTC quiet window, not during the working day.
2. **Thresholds drift.** "Using current thresholds" means a re-run after a threshold change produces different history for the same day. Either that is accepted and documented, or reconstructed rows record the thresholds used (the transition rows already carry theirs).
3. **Never suppressed** (spec §10) — the reconstruction must skip that status even where the facts would imply it, because suppression could not have happened before launch.
4. **"Unclassified"** — sends older than the backfill window need a row count on the page, which means the query must distinguish "no stamp" from "stamped as X".
5. Whether Sales/CR/Revenue ship at all, per the 1,527 figure above.

## Not blocking, but adjacent

Nothing here changes audience selection, eligibility or the drain, so PR 5 is not gated behind campaign 1460's comparison — but the reconstruction is a large data write and will need its own approval and off-peak window, like PR 1's backfill.
