# Design — opt-out-rate breaker: aligned cohort, per-stage scope, visible pause

_Last updated: 2026-07-26_
_Branch: `fix/optout-breaker-cohort` · fixes the defect diagnosed in [optout-rate-breaker-false-trip-2026-07-25.md](../../optout-rate-breaker-false-trip-2026-07-25.md)_

**No migration.** Every column this needs already exists (`opt_out_attributions.stage_send_id`,
`campaigns.send_paused/_reason/_at`, `campaign_stages.schedule_missed_at`). The change is
entirely in query shape, scope, and surface.

---

## 1. The defect, in one line

The breaker divided **STOPs counted by arrival time** by **messages counted by send
time**. Those are different cohorts, so the ratio is not a rate of anything and is
unbounded above — ~24h after a blast, its STOPs are still inside the numerator while its
messages have left the denominator. Four campaigns latched on 2026-07-25 at a reported
15–37% against true per-stage rates of 0.75–2.80%.

Raising the threshold does not fix an unbounded quantity.

## 2. What changed

### 2.1 Align the cohorts (the fix)

The numerator now reaches its time bucket through the send that produced it:

```sql
FROM opt_out_attributions oa
JOIN stage_sends ss ON ss.id = oa.stage_send_id
WHERE oa.org_id = $1 AND oa.stage_id = $2 AND ss.status = 'sent'
  AND ss.sent_at > now() - make_interval(secs => $window)
```

Both sides now describe the same messages. The metric reads: *"of what this stage sent in
the window, what fraction has produced a STOP so far."*

**NULL `stage_send_id` rows are excluded**, with no `stage_id` fallback. A fallback would
have to bucket those rows by `oa.created_at`, i.e. reintroduce the exact defect for
precisely the rows that cannot be aligned. Verified blind spot: **0 of 43,487 rows
all-time**; `oa.stage_id = ss.stage_id` in 100% of joined rows; 0 rows join to a
`sent_at IS NULL` send. The join is lossless on current data. Because
`stage_send_id` is `ON DELETE SET NULL`, that could change silently, so it is watched
(§2.4).

**Known trade-off (accepted).** A cohort rate under-reads immediately after a blast,
because the STOPs have not arrived yet. That is the safe direction — a late true trip
beats a fabricated one — and §2.3 restores fast reaction.

### 2.2 Per-stage evaluation, per-campaign latch

`checkOptOutRateBreaker` now takes `stageId` and judges **that stage**. The latch is still
`latchCampaignPause(campaignId)`.

Why: a campaign mixes a 9,669-message blast with 200-message behavioural lanes. A
campaign-level average is dominated by whichever stage is loudest, which is what made the
false trips look plausible. Per-stage is the homogeneous cohort. The pause stays
per-campaign because that is the unit an operator can act on.

**No fan-out.** Only the attributed stage is evaluated. A STOP credits exactly one stage,
so no other stage's numerator moved; their denominators only ever grow with new sends,
which *lowers* a rate and cannot trip one. Fanning out would multiply the per-STOP query
cost for zero new information.

Indexes used: `stage_sends_stage_id_idx`, `opt_out_attributions_stage_id_idx` (the join to
`stage_sends` is by primary key).

The audit reason names the stage and the window, so the row stays meaningful after the
numbers move on:

```
optout_rate_spike: 12.4% (62/500) on stage 1713 over 24h
```

### 2.3 Short-window twin

| window | env | default |
| --- | --- | --- |
| long threshold | `OPTOUT_RATE_SPIKE_THRESHOLD` | 0.10 |
| long floor | `OPTOUT_RATE_MIN_SENDS` | 200 |
| long window | `OPTOUT_RATE_WINDOW_SEC` | 86400 |
| short threshold | `OPTOUT_RATE_SPIKE_THRESHOLD_SHORT` | **0.08** |
| short floor | `OPTOUT_RATE_MIN_SENDS_SHORT` | **200** |
| short window | `OPTOUT_RATE_WINDOW_SHORT_SEC` | **7200** |

**Calibration**, re-derived on the aligned per-stage cohort (318 stages ≥200 sends):

| cohort | p95 | p99 | max |
| --- | --- | --- | --- |
| 24h | 7.19% | 8.03% | **8.41%** |
| 2h | 5.23% | 5.92% | **6.12%** |

Each threshold sits above the observed maximum, so a healthy stage cannot trip. The stale
comment in the code (*330 stages ≥50 sends: p95 7.4%, p99 8.4%, max 13.8%*) was replaced —
those were per-stage **lifetime aligned** rates, already a different metric from the
receipt-time one the runtime evaluated. That mismatch was the bug hiding in plain sight.

**Query budget is unchanged at 2 per STOP.** The short window is a strict subset of the
long one, so each side computes both counts in one pass with `FILTER`:

```sql
SELECT count(*) FILTER (WHERE sent_at > now() - make_interval(secs => $long))::int  AS n_long,
       count(*) FILTER (WHERE sent_at > now() - make_interval(secs => $short))::int AS n_short
FROM stage_sends
WHERE org_id = $1 AND stage_id = $2 AND status = 'sent'
  AND sent_at > now() - make_interval(secs => $long)
```

The two queries stay **sequential** (not `Promise.all`) — this runs inside the ingester's
transaction, and concurrent `execute()` on a postgres-js tx connection desyncs its
pipeline.

`tripped_by: "24h" | "2h" | null` reports which window breached; the result carries that
window's counts, falling back to the long window when nothing trips. When both breach the
short (acute, most-recent) one is reported — it is the more actionable description.

### 2.4 Null-`stage_send_id` guard — hourly cron, not the hot path

`findUnjoinableOptOutAttributions(db, { windowHours })` → `{ nulls, total, pct }`, plus the
pure `shouldAlertUnjoinable` / `formatUnjoinableAlert`, following the
`findStalledStages` / `formatStallAlert` pattern. Wired into
`/api/cron/telegram-report` beside `checkStalledQueue`, try/catch-wrapped, alerting when
`pct > 5%` on a sample of ≥20 rows.

Not in `checkOptOutRateBreaker`: that would add a query to every STOP and, once breached,
alert on every STOP with no dedup. The ≥20 sample floor is an addition to the brief — the
same small-sample discipline the breaker's own min-send floor exists for (1 unjoinable row
of 3 is 33% and would nag hourly).

### 2.5 The pause is now visible

Both scheduler phases filter `c.send_paused IS NOT TRUE` **upstream** of the code that
stamps `schedule_missed_at`, so a due stage on a paused campaign changes no state at all —
it rendered as an ordinary blue "Prepared" card. That is why the incident presented as
*"why does it say the window is closed?"* rather than *"why is this campaign paused?"*.

- New stage operational status **`blocked`** — "Blocked — campaign send paused", rose,
  `willSend: attention`, `sortWeight: 0`, in `STAGE_STATUS_ORDER` after `held`.
- `deriveStageOperationalStatus` gains `campaignSendPaused`, checked **after**
  `scheduleMissedAt` (a genuinely missed window is the louder, less recoverable fact) and
  **before** `slipHoldAt` (while the campaign is paused, releasing a lane hold changes
  nothing — the campaign latch is the binding constraint).
- **Deviation from the brief, deliberate:** only stages with *outstanding work*
  (`pending`/`sending` rows, or scheduled-but-unprepared) read `blocked`. A stage that
  finished sending before the pause is not affected by it; marking it "Blocked" would
  mis-state history and inflate `held_stages` / `held_messages` on the banner.
- `/api/sends/today` and `/api/sends/autopilot` select the **already-joined**
  `c.send_paused` / `_reason` / `_at` — no extra query, no new join — and gain a top-level
  `paused_campaigns[]` computed in JS by the shared pure `summarizePausedCampaigns`
  (one helper so the two dashboards can't drift).
- `/sends/today`: banner above the stage list mirroring the org hard-stop banner, with a
  per-campaign Resume button gated on `can("campaigns.pause")`; red *campaign paused* chip
  next to the provider chip; `· held by campaign pause` on the pending count.
- `/sends/autopilot`: the same chip, and Resume slotted into the existing action column
  ahead of Release/Abort (which are no-ops while the circuit is latched).

### 2.6 Resume + re-date in one transaction

`decideScheduledSend` is anchored to `scheduled_at`'s **ET day**, so resuming after that
day's window has closed makes the next tick stamp `schedule_missed_at` instead of sending.
Recovery genuinely needs resume **and** re-date.

- `POST /api/campaigns/[campaignId]/send-circuit` gains optional
  `redate_stages: [{ stage_id, scheduled_at }]`, applied in the **same transaction** as the
  resume. A bad entry `throw`s (not `return`s) so the whole recovery rolls back — returning
  early from the tx callback would commit a half-applied resume, the exact failure this
  endpoint exists to prevent.
- `GET` on the same route classifies each unfired stage with `decideScheduledSend`:
  `fire` (window open — nothing to do), `hold` (window opens later today), `future`,
  `unscheduled`, `missed` (needs a new time, prefilled from
  `nextWindowOpenAtOrAfter(cfg, now)`).
- `<CampaignResumeDialog>` is a `<FormDialog>` per CLAUDE.md §9, and converts times with
  `campaignLocalInputToUtcIso` / `utcToCampaignLocalInput` per §6 — never bare date-fns
  `format()`.
- Server-side validation: `isScheduledAtInPast` (60s grace), duplicate `stage_id`
  rejected, `redate_stages` rejected with `action: "pause"`. Re-dates route through
  `decideScheduleEdit` so `clearMissed` comes from the one place that owns that rule (the
  reschedule lock is structurally false for held stages, which have `sent_at IS NULL`).
- Held stages stay **un-missed** — that already-de-facto behaviour is what distinguishes
  "we held this" from "the window elapsed".

## 3. Verification

- `scripts/test-optout-breaker-decision.ts` — **46 assertions, offline** (no DB, no env).
  Decision math incl. the four incident campaigns' exact shapes, both windows, the floors,
  the reason/alert strings, `blocked` precedence, the paused-campaign rollup, and the
  unjoinable guard.
- `scripts/test-optout-rate-breaker.ts` — DB integration suite (rolled-back tx). The old
  fixture inserted attributions with a NULL `stage_send_id`, which the aligned join
  correctly counts as **zero**, so scenarios 2/3/4 would have failed on correct code; the
  fixture now attaches every attribution to a real `stage_sends` row with a controlled
  `sent_at`, and `oa.created_at` is set independently so a scenario can prove the two no
  longer interact. New scenarios: the false-trip regression, the short twin, NULL exclusion,
  per-stage isolation, the reason string, and the unjoinable detector.
- `scripts/verify-optout-breaker-alignment.ts` — **read-only** replay of the production
  queries + pure decision over every stage that sent in the last 24h.

## 4. Open items

- The four campaigns latched on 2026-07-25 remain paused with misleading
  `send_paused_reason` strings. Resuming them is a human action (and the new dialog is the
  intended path).
- The Text Request opt-out ingesters (`lib/sends/textrequest-optout.ts`,
  `textrequest-dlr-optout.ts`) are **not on `main`** — they live on the unmerged
  `feat/textrequest-send` branch. Their `checkOptOutRateBreaker` calls will need
  `stageId: match.stage_id` added when that branch merges; `match.stage_id` is already in
  scope at both call sites.
