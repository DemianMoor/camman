# Brief — opt-out-rate breaker false-trips (2026-07-25)

**Status:** diagnosed, not fixed. No code changed. All investigation was read-only.
**Impact:** 4 campaigns auto-paused on false signals; ~26,500 messages stranded; 2 stages silently missed their send window.
**Last updated:** 2026-07-25

---

## 1. TL;DR

The per-campaign opt-out-rate breaker (P7/P8) computes its rate from two counters
measured on **different cohorts**:

- **numerator** — STOPs counted by *when the STOP arrived* (`opt_out_attributions.created_at`)
- **denominator** — messages counted by *when they were sent* (`stage_sends.sent_at`)

STOPs trail their originating send by up to a full day. So roughly 24 h after a
large send, that send drops out of the denominator while the STOPs it generated
are **still inside** the numerator. The ratio then explodes against whatever
small volume happens to be left, and the campaign latches itself paused.

On 2026-07-25 this tripped four campaigns between 10:51 and 11:33 ET at reported
rates of 37.3% / 29.2% / 20.0% / 15.0%. Recomputed on an aligned cohort the same
four campaigns were at **6.2% / 2.4% / 3.7% / 2.0%** — none would have tripped.
The true per-stage lifetime opt-out rates were 0.75–2.80%.

This is not a tuning problem. The rate being computed is not a rate of anything.

---

## 2. What the functionality is

**Purpose.** A high STOP rate is a content/audience signal rather than a
transport fault, so this breaker pauses **one campaign** instead of the whole
provider. It sits alongside the older per-provider breakers (failure spike,
pacing ceiling, Ahoi DLR reject rate) and is ANDed with them: a paused provider
still freezes all of its campaigns; this only ever adds freezes within a
still-live provider.

**Code map.**

| Concern | Location |
| --- | --- |
| Rate check + latch decision | [`lib/sends/optout-rate-breaker.ts`](../lib/sends/optout-rate-breaker.ts) — `checkOptOutRateBreaker` |
| Numerator query | [`lib/sends/circuit-breakers.ts`](../lib/sends/circuit-breakers.ts) — `countOptOutAttributionsSince` |
| Denominator query | [`lib/sends/circuit-breakers.ts`](../lib/sends/circuit-breakers.ts) — `countSentSinceForCampaign` |
| Latch + audit row | [`lib/sends/circuit-breakers.ts`](../lib/sends/circuit-breakers.ts) — `latchCampaignPause` |
| Mid-drain kill | [`lib/sends/drain.ts`](../lib/sends/drain.ts) — `isCampaignPaused` at the batch boundary |
| Scheduler gates | [`lib/sends/scheduled.ts`](../lib/sends/scheduled.ts) — `c.send_paused IS NOT TRUE` in **both** phase selects |
| Manual resume | `POST /api/campaigns/[campaignId]/send-circuit` |
| Tests | [`scripts/test-optout-rate-breaker.ts`](../scripts/test-optout-rate-breaker.ts) (15/15 green) |

**Callers.** Every opt-out ingestion path calls the check immediately after
recording an attribution: the TextHub inbox poll
([`poll-opt-outs.ts`](../lib/sends/poll-opt-outs.ts)), the Ahoi inbound webhook
([`ahoi-optout.ts`](../lib/sends/ahoi-optout.ts)), the Text Request intake
([`textrequest-optout.ts`](../lib/sends/textrequest-optout.ts)), and the
send-time rejection path in the drain.

**Transactionality.** The latch runs inside the ingester's transaction (atomic
with the attribution); the Telegram alert fires post-commit so a rollback can't
emit a false alarm. `latchCampaignPause` is idempotent (`WHERE send_paused = false`)
and appends exactly one `campaign_circuit_events` row, so alerts never repeat.

**Configuration** (env-tunable, read through helpers so no redeploy is needed):

| Setting | Env var | Default |
| --- | --- | --- |
| Threshold | `OPTOUT_RATE_SPIKE_THRESHOLD` | `0.1` (10%) |
| Minimum sends floor | `OPTOUT_RATE_MIN_SENDS` | `200` |
| Trailing window | `OPTOUT_RATE_WINDOW_SEC` | `86400` (24 h) |

**Latching semantics.** The pause is sticky by design — it stays until a human
resumes it. That is correct for a breaker; it is what makes the false-positive
expensive.

---

## 3. The defect

The two counters are queried over the same 24 h interval but against different
time columns.

```sql
-- numerator: WHEN THE STOP ARRIVED
SELECT count(*) FROM opt_out_attributions
WHERE org_id = $1 AND campaign_id = $2
  AND created_at > now() - make_interval(secs => $3);

-- denominator: WHEN THE MESSAGE WENT OUT
SELECT count(*) FROM stage_sends
WHERE org_id = $1 AND campaign_id = $2
  AND status = 'sent'
  AND sent_at > now() - make_interval(secs => $3);
```

`created_at` on an attribution is the STOP **receipt** time stamped by the
ingester. The lag between a send and its STOPs is not small and not uniform —
observed spread for one stage was the **full 24 hours** after the send, and the
TextHub inbox poller adds its own latency on top.

Consequence: as the window slides past a send burst, the numerator retains that
burst's STOPs after the denominator has dropped its messages. The computed
"rate" becomes `STOPs from an old send ÷ messages from a new send`, which is not
a ratio of anything meaningful and is unbounded above.

**Worth noting for calibration.** The comment above the defaults cites live data
— *"330 stages ≥50 sends: p95 7.4%, p99 8.4%, max 13.8%"*. Those are **per-stage
lifetime** rates, i.e. STOPs measured against the send that produced them — the
aligned definition. The 10% threshold was therefore calibrated on a different
metric from the one the runtime actually evaluates.

---

## 4. Why it fires deterministically

The failure needs only two conditions, both normal here:

1. **Uneven daily volume** — one large blast, then a much smaller send the next day.
2. **STOP lag ≥ the window length** — replies still arriving ~24 h after the blast.

The trip time is predictable: shortly after the blast rolls out of the window,
the next arriving STOP recomputes the rate against the now-tiny denominator and
latches. All four campaigns tripped 24 h + ε after their previous-day blast.

For campaign 465 the final STOP from the expired blast arrived at 10:51:39 ET
and the pause latched at **10:51:46 ET** — seven seconds later.

Any campaign with a "big blast, then behavioral-lane follow-ups" shape will hit
this on a roughly daily cadence.

---

## 5. Evidence (2026-07-25)

### 5.1 The four trips

| Campaign | Latched (ET) | Reported | Denominator | Numerator | Share of numerator from sends **outside** the denominator |
| --- | --- | --- | --- | --- | --- |
| 465 Glyco Balance — WL USED no Glyco | 10:51 | 37.0% | 322 | 119 | 108/120 = **90%** |
| 467 Lulutox — Manifestation | 11:11 | 29.2% | 253 | 74 | 71/74 = **96%** |
| 464 Kinzeno — WL Used Lulutox | 11:33 | 15.0% | 254 | 38 | 34/38 = **89%** |
| 463 Kinzeno — Memory | 11:33 | 20.0% | 410 | 82 | 79/82 = **96%** |

(Recomputing at the stored `send_paused_at` gives 120 rather than the logged 119
for campaign 465 — one further attribution committed between the count and the
timestamp. Immaterial.)

### 5.2 Campaign 465 in detail

| Event | Time (ET) | Volume |
| --- | --- | --- |
| Stage 1532 blast sent | Jul 24, 10:42–10:48 | **9,669 messages** |
| Its STOPs arrived | Jul 24 10:51 → Jul 25 10:51 | 108 within the numerator window |
| Contribution of that blast to the denominator at latch | — | **0** (24 h 06 m old) |
| Actual denominator | Jul 25, 10:02–10:06 | 322 (lane stages 1714 + 1715) |
| Latch | Jul 25, 10:51:46 | 120 ÷ 322 = **37.3%** |

Stage 1532's real opt-out rate: **179 / 9,669 = 1.85%**.

### 5.3 Counterfactual with an aligned cohort

Numerator re-counted by joining `opt_out_attributions.stage_send_id →
stage_sends.sent_at`, so both sides describe the same messages:

| Campaign | Denominator | Current (receipt-time) | Aligned (send-cohort) |
| --- | --- | --- | --- |
| 465 | 322 | 120 → **37.3% TRIPS** | 20 → 6.2% ok |
| 467 | 253 | 74 → **29.2% TRIPS** | 6 → 2.4% ok |
| 463 | 410 | 82 → **20.0% TRIPS** | 15 → 3.7% ok |
| 464 | 254 | 38 → **15.0% TRIPS** | 5 → 2.0% ok |

`stage_send_id` was non-null for **every** attribution in all four windows, so
the join loses nothing on current data.

### 5.4 Lifetime rates of the stages involved

0.75%, 1.85%, 1.67%, 2.19%, 2.27%, 2.28%, 2.70%, 2.80%, 3.21%, 5.45% — plus two
tiny-sample lanes (18/283 = 6.36%, 2/14 = 14.29%). Nothing near the reported
15–37%.

---

## 6. Collateral issues found alongside

These are independent of the rate math and worth fixing regardless.

**6.1 A paused campaign's due stages fall into silent limbo.**
`c.send_paused IS NOT TRUE` filters both phase selects in
[`scheduled.ts`](../lib/sends/scheduled.ts), so a due stage on a paused campaign
is never drained **and** never reaches the code that stamps
`schedule_missed_at`. Stages 1713 (due 15:00 ET, 9,180 pending) and 1710 (due
18:00 ET, 4,396 pending) sat fully materialized with `sent_at IS NULL` and
`schedule_missed_at IS NULL` — indefinitely, with no state change to notice.

**6.2 The campaign pause is invisible on the operational dashboards.**
[`app/api/sends/today/route.ts`](../app/api/sends/today/route.ts) and
[`app/api/sends/autopilot/route.ts`](../app/api/sends/autopilot/route.ts) both
select `p.send_paused AS provider_paused` but never `c.send_paused`. A latched
campaign renders as an ordinary "Prepared" card whose only red text is the
send-window indicator — which is accurate but unrelated. This is what made the
incident present as "why does it say the window is closed?" rather than "why is
this campaign paused?".

**6.3 Resuming after the window closes marks the stage missed.**
`decideScheduledSend` is anchored to `scheduled_at`'s ET day, so resuming a
campaign after that day's window has closed causes the first tick to stamp
`schedule_missed_at` rather than send. Recovery requires resume **and** re-dating
`scheduled_at` into a future window. Worth an explicit UI affordance if operators
are expected to recover from a pause themselves.

---

## 7. Proposed fix

**Primary — align the cohorts.** Count the numerator by the originating send's
`sent_at` instead of the STOP's arrival time:

```sql
SELECT count(*) FROM opt_out_attributions oa
JOIN stage_sends ss ON ss.id = oa.stage_send_id
WHERE oa.org_id = $1 AND oa.campaign_id = $2
  AND ss.sent_at > now() - make_interval(secs => $3);
```

Both sides then describe the same messages, and the metric becomes "of what we
sent in the last 24 h, what fraction has produced a STOP so far".

`stage_send_id` already exists on `opt_out_attributions` with
`ON DELETE SET NULL` lineage. The nullable case needs a decision (see §8).

**Known trade-off.** A cohort rate under-reads immediately after a blast,
because the STOPs haven't arrived yet — the breaker gets slower to catch a
genuinely bad send. That is the safe direction (a late true trip beats a
fabricated one), but it does weaken the "stop the bleeding fast" intent. If the
detection lag matters, options include:

- a **maturity floor** — only judge sends that are at least N hours old, and let
  a separate fast-reacting rule cover the first N hours;
- a **short-window twin** — e.g. a 2 h cohort alongside the 24 h one, so a
  genuinely toxic creative still trips quickly;
- **per-stage evaluation** instead of per-campaign, since a campaign mixes stages
  with very different audiences and the blast/lane asymmetry is what breaks the
  campaign-level average.

**Recalibration.** Once the metric is well-defined, the 10% threshold should be
re-derived against the corrected definition. The existing p95/p99 figures are
already close to the right basis.

**Backfill / cleanup.** The four latched campaigns need resuming, and the
`send_paused_reason` strings on them are misleading as an audit record.

---

## 8. Questions for review

1. **Nullable `stage_send_id`.** Attributions whose send row was pruned would
   silently leave the numerator under the join. Count them separately, fall back
   to `stage_id`, or accept the loss? (Currently zero affected rows.)
2. **Detection lag.** Is a 24 h cohort acceptable on its own, or do we want a
   short-window twin / maturity floor to preserve fast reaction?
3. **Scope.** Per-campaign or per-stage? The blast-vs-lane asymmetry is a
   campaign-level artifact; per-stage rates were all sane throughout.
4. **Limbo handling (6.1).** Should a paused campaign's due stages be stamped
   missed, or deliberately preserved un-missed so they're recoverable on resume?
   If preserved, they need a visible state of their own.
5. **Did the Telegram alerts arrive** at 10:51 / 11:11 / 11:33 ET? They are
   best-effort post-commit; if they didn't land, that's a separate gap.
6. **Interim mitigation.** Raise `OPTOUT_RATE_SPIKE_THRESHOLD` temporarily, or
   accept daily false trips until the fix lands? Note that raising it does not
   remove the failure mode — the computed rate is unbounded, so any threshold can
   be exceeded.

---

## 9. Reproducing the numbers

All figures came from read-only queries against the production database. The
core one, per campaign, at its stored `send_paused_at`:

```sql
SELECT
  (SELECT count(*) FROM stage_sends
    WHERE campaign_id = $c AND status = 'sent'
      AND sent_at > $latch::timestamptz - interval '24 hours'
      AND sent_at <= $latch::timestamptz)                        AS denominator,
  (SELECT count(*) FROM opt_out_attributions
    WHERE campaign_id = $c
      AND created_at > $latch::timestamptz - interval '24 hours'
      AND created_at <= $latch::timestamptz)                     AS numerator_current,
  (SELECT count(*) FROM opt_out_attributions oa
    JOIN stage_sends ss ON ss.id = oa.stage_send_id
    WHERE oa.campaign_id = $c
      AND ss.sent_at > $latch::timestamptz - interval '24 hours'
      AND ss.sent_at <= $latch::timestamptz)                     AS numerator_aligned;
```

Latch timestamps are in `campaigns.send_paused_at` and `campaign_circuit_events`
(ids 11–14).
