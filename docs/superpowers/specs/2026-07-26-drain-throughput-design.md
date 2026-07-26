# Drain throughput — design

_2026-07-26 · branches `fix/send-scheduled-lease` (Phase 1) → `perf/drain-throughput` (Phase 2) · ClickUp 869e9dq6f_

## 1. What was actually wrong

Recon measured the live drain rather than assuming. Three findings overturned the
starting hypothesis:

| Claim | Reality |
|---|---|
| "The send loop is serial" | **False.** Sends have been 50-wide `Promise.all` since the parallel-slice change ([drain.ts](../../../lib/sends/drain.ts)); 50 rows share one identical `sent_at` per slice. |
| "The provider is throttling us" | **False.** **Zero** 429s in 780,012 attempts; genuine transport failures 46 = **0.006%**. |
| "Link minting is on the send path" | **False.** `mintLinksBatch`/`buildStageSms` are imported only by `kickoff.ts`; the drain reads pre-rendered `rendered_text`. |

The real bottleneck: **11 sequential DB round-trips per 50-message batch**.
Server-side execution of all 11 statements is **78 ms** (EXPLAIN ANALYZE); the
rest is pooler latency (**278 ms** p50 per hop). Cycle **2.482 s** ⇒ **20.14
msg/s** against a **60/s** configured number.

Two structural bugs sat underneath it:

1. **The pacing sleep was dead code above 50/s.** `batchSize = 50` but the slice
   loop steps by `rate` (60), so it ran ONCE per batch and compared an 833 ms
   target against a 2,482 ms real cycle — it never slept. `batchSize`, not
   `rate`, was the throughput knob. (It still bound correctly at 3/s: 821 slice
   gaps in the 1.00–1.10 s band, p50 1.006 s.)
2. **Same-phone stages starved each other.** `drainPhoneGroup` round-robined
   stages in 20 s slices, so a phone's aggregate never exceeded ONE stage's
   throughput regardless of how many waited. Stage 1705 was held to **3.02
   msg/s** — 24 drain sessions of ~18 s separated by 68–282 s gaps.

And one latent hazard: the cron took **no lease**, so an overrunning tick
overlapped the next and two drain loops shared a number. Per-second pacing is
per-*invocation*, so N overlapping invocations multiply real MPS by N. Measured
overlap: 54,340 messages under 2 concurrent loops, slice gap 2.48 s → 1.22 s,
19.9/s → 39.7/s, **zero duplicates**, zero elevated errors. Safe only by
arithmetic accident (2 × 20 < 60).

## 2. Phase 1 — the lease (must land first)

Closing the overlap BEFORE raising concurrency, or the throughput work converts a
latent hazard into a live MPS violation.

- **Per PHONE, not per job.** The lease is exactly as wide as the resource it
  protects (one number's MPS allowance). Different numbers stay parallel — the
  2026-07-24 head-of-line fix must not regress into a global single-runner.
- **A `cron_locks` lease ROW, not `pg_advisory_lock`.** `DATABASE_URL` targets
  Supavisor's transaction pooler (`:6543`), where a *session* advisory lock can be
  lost/stranded on backend reassignment (the standing reason this codebase has
  never used them). A *transaction-scoped* lock would be pooler-safe but would pin
  the whole multi-minute drain to one connection and one transaction — the
  opposite of the per-window-commit resumable design.
- **Crash-safe by absolute expiry.** TTL = `PHASE_B_DEADLINE_MS`, which provably
  covers the work: the deadline is measured from RUN start, the lease from GROUP
  start (≥ run start). Released in `finally` via CAS on the exact token. One cron
  period > TTL ⇒ the next tick always reclaims a killed run's phone.
- **A blocked phone skips cleanly** — rows stay `pending`, nothing marked missed,
  no error escapes. Counted as `phone_lease_skipped`.
- Applies to the **manual** trigger too, unlike the job-wide `withCronLease`
  convention: an MPS breach doesn't care who started the drain.

## 3. Phase 2 — throughput ("staged", ~50/s; pipelined writes deferred)

| # | Change | Why |
|---|---|---|
| 1 | `batchSize` derives from the rate: `clamp(rate × 10, 50, 2000)` | Amortize the ~2.3 s preamble over ~10 s of sending instead of 50 rows |
| 2 | Real per-phone **token bucket** replaces the dead sleep | Binds at 3/s AND 60/s, and across stages sharing a number |
| 3 | Same-phone stages drain **concurrently** (≤3) sharing that bucket | Kills the 3.02 msg/s starvation; MPS enforced by the bucket, not by serializing stages |
| 4 | `BUDGET_RESERVE_SLICE` → `rate × 30 s`, clamped [200, 5000] | 5,000 was sized for ≤1,200-row round-robin slices; it is now both too small at 60/s and a whole-cap grab at 3/s |
| 5 | Memoize `countSentSince(…, 86400)` per invocation | 59.29 ms, the only statement scaling with history |
| 6 | `db/client.ts max: 5 → 16` | 8 groups × 3 stages = 24 workers were queueing on a 5-slot pool (why 2 phones gave 1.5×, not 2×) |
| 7 | 1-hour dedup set spans the whole invocation | Concurrent slices could both pass the committed-`sent` probe |
| 8 | `PHASE_B_DEADLINE_MS` 240 s → 270 s | Minute +4 of every `*/5` cycle was collapsing (see §5) |
| 9 | `send_attempts.latency_ms` + adapter clocks | The one number the drain could never observe |
| 10 | Soft-yield moved to slice boundaries | A 10 s batch would otherwise overshoot the deadline by most of a batch |

### Design points worth recording

**The bucket is virtual scheduling (GCRA-shaped), not a token counter.** Each
message occupies `1000/rate` ms of a virtual timeline; `take(n)` RESERVES the next
n slots and waits until its reservation starts. The reservation is **synchronous**
— no await between reading and writing `nextAvailableAt` — which is what makes it
safe for concurrent stages; the same single-threaded discipline `makeProviderBudget`
already relies on. A pacer that read, awaited, then wrote would let two stages both
claim the same second. Idle time is clamped, never banked, so a quiet minute can't
be cashed in as a 60× burst.

**Sub-claims were considered and rejected.** Claiming in small chunks inside one
preamble would bound stranded rows, but it re-pays the claim + opt-out + dedup
round-trips per chunk: 3 × 278 ms per 60 rows ⇒ ~33 msg/s, *worse* than the
problem being solved. Instead the yield path returns claimed-but-undispatched
rows to `pending`, so the only case that scales with batch size is a hard crash.

**Slice-boundary yield keeps `off > 0`.** A claimed batch ALWAYS dispatches at
least one slice. Without that guard, a time-box shorter than the preamble would
claim rows, send none, release them, and repeat forever — zero forward progress
per tick. Overshoot is bounded to one slice instead of one batch.

## 4. Emission shape — implemented, measured, REVERTED

The bucket fixes the **sustained** rate. It does not change the **burst** shape:
the drain still fires a whole slice of `rate` at once and then waits. Aligned
wall-second counting shows exactly `rate`; a SLIDING one-second window straddling
two slice boundaries can transiently show up to **2 × rate**.

Smoothing this (sub-slices of `rate/10` spaced ~100 ms, spread by the bucket) was
implemented and measured, then reverted:

```
rate 60, prod-measured inputs (400 ms provider RTT, 278 ms pooler RTT)

BURST     sends 400ms → persist 2×278 = 556ms → work 956ms
          bucket window for 60 msgs = 1000ms
          ⇒ the persist HIDES INSIDE the pacing wait      cycle 1000ms / 60

SUB-SLICE last sub-slice starts +900ms, lands +1300ms
          persist 556ms is serialized after the whole slice
          ⇒ cycle 1856ms / 60  =  32/s        a 40% loss
```

The spread consumes the entire pacing window, so the persist no longer fits inside
it. Making smooth emission free requires overlapping a slice's persistence with the
next slice's sends — **pipelined writes, explicitly out of scope here**. The burst
shape is therefore *unchanged from what has always shipped*, not newly introduced,
and it should be revisited together with pipelining rather than before it.

## 5. Cron cadence

14-day aggregate of sends by minute-of-cycle: **+0m 136,647 / +1m 169,011 / +2m
169,922 / +3m 163,018 / +4m 127,294.** Minute +4 collapses because the phase stops
at 240 s of a 300 s window.

Kept `*/5` and raised the phase deadline to **270 s**. Now that Phase 1 leases the
job per phone, an overrun tick can no longer double-send, so the old 60 s of
head-room buys nothing. 270 s recovers half of minute +4 while reserving ~30 s for
`reconcileStuckStages` (which runs AFTER the phase in the same route) plus the
response. Shortening the *period* instead would multiply cold starts and preamble
work for the same fixed send rate.

## 6. Projected throughput (PROJECTION, not measured)

`SEND_ENABLED` gating and the no-live-send rule mean this cannot be measured here.
Arithmetic from the prod-measured inputs above, for a 60/s short code:

```
batch = clamp(60 × 10, 50, 2000) = 600 rows

preamble (8 round-trips; the 24h count is memoized after the first batch)
  8 × 278 ms                                    = 2.224 s
  + server-side execution                       ≈ 0.04  s
                                                 -------
                                                  2.26  s

per slice (60 msgs)
  sends (parallel, ~400 ms) + persist (2 × 278 = 556 ms) = 956 ms of work
  bucket window                                          = 1000 ms  ← binds
  ⇒ 1.0 s per slice, 10 slices per batch                 = 10.0  s

cycle = 2.26 + 10.0 = 12.26 s per 600 messages
      ⇒ 600 / 12.26 = 48.9 msg/s
```

**≈ 49 msg/s vs 20.14 measured today — about 2.4×**, against a 60/s ceiling
(≈ 81 % of configured; the preamble is the remaining 19 %).

Independent corroborations of the ceiling: two concurrent invocations measured
39.7 msg/s on one number with no errors, and TextHub absorbed 2,400 msg/min on a
single number.

At 3/s the batch floors at 50 rows — **identical to today's behavior**, no
regression. Same-phone starvation goes from 3.02 msg/s to the number's full rate.

## 7. Risks and how each is handled

| Risk | Handling |
|---|---|
| **At-most-once** | `FOR UPDATE SKIP LOCKED` untouched. The yield path only reverts rows with `status = 'sending'` that were provably never dispatched. Asserted: no row attempted twice under concurrency. |
| **Breaker reaction time** | Kill switches are still re-read between batches; a batch grew 2.5 s → ~12 s at 60/s, so a pause now takes effect up to ~12 s / ~600 messages later. Documented, not hidden; `BATCH_SECONDS` is the single knob to dial it back. `FAILURE_SPIKE_THRESHOLD` needs **no** re-tuning — it latches inside the slice fold, so its bound is still ≤ `rate−1` past the threshold. |
| **Stranded `sending` rows** | Clean yields now return undispatched rows to `pending` (asserted: zero stuck). Only a hard crash strands, and `reconcileStuckStages` still finalizes those as `failed`, never re-sent. |
| **Per-phone MPS** | Enforced by the shared bucket, asserted at 3/s and 60/s on a deterministic clock and on real dispatch timestamps. Sustained rate ≤ configured; burst shape unchanged (§4). |
| **24h ceiling weakened by the memo** | Per-provider key preserved; locally-emitted sends folded in via `addSent`; hard read-through within 90 % of the cap. |
| **Pool exhaustion** | `max` raised deliberately in step with the worker count, against the TRANSACTION pooler (not the session-mode ~15 cap the old value assumed). `globalThis` caching kept. |

## 8. Migration ordering (blocking)

`0125_send_attempts_latency.sql` is **authored and deliberately NOT applied**.

- Numbered **0125** because the unmerged `feat/textrequest-send` branch already
  holds **0121–0124** (also unapplied). **Apply 0121–0124 FIRST.**
- The snapshot's `prevId` points at 0120 (the newest on this branch) and must be
  re-pointed at 0124's id when those merge first.
- The drain writes `latency_ms` **only when the column exists** (memoized
  `information_schema` probe), so the code is safe to deploy on either side of the
  migration and starts recording the moment it applies.
- `scripts/verify-migration-integrity.ts` was indexing the journal array by `idx`,
  which crashes on the deliberate 0121–0124 gap; it now cross-checks by apply
  order and asserts `idx` monotonicity instead.

## 9. Explicitly not done

- **Pipelined persistence** (`pendingWrite` promise) — deferred pending
  measurement, per scope. It is the prerequisite for both >50/s and free emission
  smoothing (§4).
- Merging the 4 per-batch kill-switch reads into one statement (would cut 3
  round-trips/batch but breaks the injectable `isOrgEnabled`/`isOrgPaused` test
  seams).
- Any live-fire measurement — no SMS was sent.
