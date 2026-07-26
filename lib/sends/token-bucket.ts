// Per-PHONE send pacer.
//
// WHY THIS REPLACED THE OLD SLEEP. The drain used to pace by sleeping the
// shortfall after each slice: `target = (slice.length / rate) * 1000; if (elapsed
// < target) sleep(target - elapsed)`. That is only correct while a slice is
// actually smaller than a batch. With `batchSize = 50` and `rate = 60` the slice
// loop (`off += rate`) ran EXACTLY ONCE per batch, and the single sleep compared
// a 833 ms target against a ~2,482 ms real cycle — so it never slept. The pacer
// was DEAD CODE on every phone above 50/s (measured live: 20.14 msg/s against a
// 60/s configuration), while still binding correctly at 3/s (measured: 821 slice
// gaps in the 1.00–1.10 s band). Raising the batch size makes the slice loop
// iterate, so pacing starts to matter again — and it now has to be right at BOTH
// ends of the range, and ACROSS the stages that share one number.
//
// WHY A BUCKET AND NOT A PER-DRAIN SLEEP. `max_sends_per_second` is a CARRIER
// limit on the NUMBER, not on a drain loop. Several stages can share one phone,
// and (since this change) they drain CONCURRENTLY. Any pacer living inside one
// `runStageDrain` would let N concurrent stages emit N × rate. The bucket is
// created once per phone group and passed to every stage on that number, so the
// number's rate is enforced where the limit actually lives.
//
// ALGORITHM — virtual scheduling (GCRA-shaped), not a token counter. Each
// message occupies `1000/rate` ms of a virtual timeline; `take(n)` RESERVES the
// next n slots and waits until its reservation starts. The reservation is
// SYNCHRONOUS (no await between reading and writing `nextAvailableAt`), so
// concurrent callers can never double-spend — the same single-threaded
// discipline `makeProviderBudget` relies on in lib/sends/scheduled.ts. A pacer
// that read, awaited, then wrote would let two stages both "see" the same free
// second.
//
// EMISSION SHAPE IS UNCHANGED — and that is a deliberate, measured decision.
// The caller still fires a whole slice of `rate` at once and then waits, exactly
// as the old sleep did. So SUSTAINED throughput is capped at the configured MPS
// (which is what this fixes), while a SLIDING one-second window straddling two
// slice boundaries can still transiently show up to 2 × rate. Aligned wall-second
// counting shows exactly `rate`.
//
// Smoothing that out was implemented and then REVERTED, because it is not free
// under the current write path. Spreading a 60-message slice as 6 every 100 ms
// (prod-measured inputs: ~400 ms provider round-trip, 278 ms pooler round-trip)
// pushes the last send to +1,300 ms; the slice's persistence (2 round-trips,
// ~556 ms) is serialized after it, so the cycle grows 1,000 ms → 1,856 ms and
// throughput drops 60/s → 32/s. In the burst shape those same 556 ms HIDE INSIDE
// the pacing wait (400 + 556 = 956 < 1,000) and cost nothing. Making smooth
// emission free requires overlapping a slice's persistence with the next slice's
// sends — i.e. PIPELINED WRITES, deliberately deferred (see the design doc,
// docs/superpowers/specs/2026-07-26-drain-throughput-design.md). Revisit the
// smoothing together with that, not before.
//
// CATCH-UP IS BOUNDED. If the caller stalls (slow provider, a long DB write),
// `nextAvailableAt` falls behind wall-clock; it is clamped forward to `now`
// rather than allowed to accumulate credit, so an idle minute can never be
// "spent" as a 60× burst afterwards. This is the equivalent of the old
// "sleep only the shortfall" behavior.

export interface TokenBucket {
  /** The rate this bucket enforces (messages per second). */
  readonly rate: number;
  /** Reserve `n` sends and resolve once they may be dispatched. */
  take(n: number): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function makeTokenBucket(
  ratePerSecond: number,
  // Injectable clock/sleep so tests can assert the emitted rate without
  // burning wall-clock. Production uses the real ones.
  deps?: { now?: () => number; sleep?: (ms: number) => Promise<void> },
): TokenBucket {
  const rate = Math.max(1, Math.floor(ratePerSecond));
  const slotMs = 1000 / rate;
  const now = deps?.now ?? Date.now;
  const wait = deps?.sleep ?? sleep;

  let nextAvailableAt = now();

  return {
    rate,
    async take(n: number): Promise<void> {
      if (n <= 0) return;
      const t = now();
      // Never bank idle time: a bucket that has been quiet starts from `now`,
      // so an idle minute can't be cashed in as one huge burst.
      if (nextAvailableAt < t) nextAvailableAt = t;
      // SYNCHRONOUS reservation — read and write with no await between them.
      const startAt = nextAvailableAt;
      nextAvailableAt = startAt + n * slotMs;
      const waitMs = startAt - t;
      if (waitMs > 0) await wait(waitMs);
    },
  };
}
