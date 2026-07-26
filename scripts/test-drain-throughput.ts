// Drain-throughput work (perf/drain-throughput). Covers the invariants that the
// throughput changes could plausibly break:
//
//   A. TOKEN BUCKET never exceeds the configured MPS — asserted over a simulated
//      window at BOTH 3/s and 60/s (the old sleep was correct at 3/s and DEAD
//      above 50/s, so both ends matter), including a >rate take, concurrent
//      consumers sharing one bucket, and the no-banked-credit rule. The bound is
//      SUSTAINED rate + at most one slice of instantaneous burst — the emission
//      shape the drain has always had (see lib/sends/token-bucket.ts).
//   B. BATCH SIZING derives from the rate, with floor/ceiling.
//   C. 24h-COUNT MEMO keeps per-provider scoping (ClickUp 869e659t4), still
//      self-throttles on this run's own sends, and reads through near the cap.
//   D. SAME-PHONE MULTI-STAGE concurrency shares ONE bucket: both stages make
//      progress (no starvation) AND the number's aggregate rate is still capped.
//   E. DEDUP holds across CONCURRENT slices — the same number in two same-phone
//      stages is sent exactly once, the other row is skipped_duplicate.
//   F. NO DUPLICATE SENDS under concurrency (one dispatch per row, attempts = 1).
//   G. A SLICE-BOUNDARY YIELD returns claimed-but-undispatched rows to 'pending'
//      instead of stranding them in 'sending'.
//
// D–G run the REAL runStageDrain/runScheduledSends against a throwaway org inside
// ONE transaction that is ALWAYS rolled back, with an injected sender (no network).
//
// Run: npx tsx scripts/test-drain-throughput.ts
import "./_env-preload"; // MUST be first — loads .env.local before db/client init
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  makeSentSinceMemo,
  MAX_DRAIN_BATCH,
  MIN_DRAIN_BATCH,
  resolveDrainBatchSize,
} from "@/lib/sends/circuit-breakers";
import { runStageDrain, type Sender } from "@/lib/sends/drain";
import { runScheduledSends } from "@/lib/sends/scheduled";
import { makeTokenBucket } from "@/lib/sends/token-bucket";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  → ${detail}`}`);
}

const NOW = new Date("2026-06-15T16:00:00Z");
const SCHEDULED_AT = new Date("2026-06-15T15:59:00Z").toISOString();
const ROLLBACK = Symbol("rollback");

// Virtual clock: `sleep` advances time instead of burning it, so a 10-minute
// pacing window is asserted instantly and deterministically.
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    get t() {
      return t;
    },
    advance(ms: number) {
      t += ms;
    },
  };
}

// Emit `takes` slices of `size` through a bucket and assert the MPS ceiling over
// the whole simulated window. The guarantee is GCRA-shaped: at any instant the
// count emitted so far may lead the ideal rate by at most ONE second of output
// (the same instantaneous burst the drain has always had — it fires a slice in
// parallel, then waits), and never more.
function assertRate(rate: number, size: number, takes: number) {
  const clock = virtualClock();
  const bucket = makeTokenBucket(rate, { now: clock.now, sleep: clock.sleep });
  const samples: { t: number; emitted: number }[] = [];
  let emitted = 0;
  return (async () => {
    for (let i = 0; i < takes; i++) {
      await bucket.take(size);
      emitted += size;
      samples.push({ t: clock.t, emitted });
    }
    const total = size * takes;
    const worst = samples.reduce(
      (acc, s) => Math.max(acc, s.emitted - (rate * s.t) / 1000),
      0,
    );
    check(
      `rate ${rate}/s: never leads the ideal rate by more than one second of output`,
      worst <= rate + 1e-9,
      `worst lead ${worst.toFixed(2)} msgs > rate ${rate}`,
    );
    check(
      `rate ${rate}/s: ${total} msgs occupy >= ${(total - rate) / rate}s of the window`,
      clock.t >= ((total - rate) / rate) * 1000 - 1e-9,
      `elapsed ${clock.t}ms`,
    );
    const effective = clock.t > 0 ? (total - size) / (clock.t / 1000) : Infinity;
    check(
      `rate ${rate}/s: steady-state throughput <= configured MPS`,
      effective <= rate + 1e-9,
      `effective ${effective.toFixed(2)}/s`,
    );
  })();
}

// Worst count in any sliding window of EXACTLY 1000ms. Half-open `(t-1000, t]`
// on purpose: a closed `[t-1000, t]` spans 1001ms and counts both endpoints, so
// it reports rate+1 even for perfectly uniform emission.
// EPS absorbs float drift: at a non-integer slot width (1000/3 = 333.333…) the
// accumulated virtual timestamps land ~1e-13 either side of the boundary, which
// would otherwise flip a message in or out of the window.
function worstSlidingWindow(stamps: number[]): number {
  const EPS = 1e-6;
  let worst = 0;
  for (const t of stamps) {
    worst = Math.max(worst, stamps.filter((o) => o > t - 1000 + EPS && o <= t + EPS).length);
  }
  return worst;
}

// Emit the way the DRAIN emits — one `take` of a whole slice, fired together —
// and measure the sliding-window bound on a deterministic clock. The drain has
// ALWAYS burst a slice and then waited; the bucket fixes the SUSTAINED rate, not
// the burst shape. So the honest bound is 2 x rate at a slice boundary, and this
// asserts the burst never exceeds ONE extra slice (a regression here would mean
// the pacer had started letting slices bunch up).
async function assertSlidingWindow(rate: number, seconds: number) {
  const clock = virtualClock();
  const bucket = makeTokenBucket(rate, { now: clock.now, sleep: clock.sleep });
  const stamps: number[] = [];
  for (let i = 0; i < seconds; i++) {
    await bucket.take(rate);
    for (let k = 0; k < rate; k++) stamps.push(clock.t);
  }
  const worst = worstSlidingWindow(stamps);
  check(
    `rate ${rate}/s: sliding 1s window <= one slice of burst ahead (worst ${worst} <= ${2 * rate})`,
    worst <= 2 * rate,
    `worst=${worst}`,
  );
}

async function main() {
  // ── A. Token bucket ────────────────────────────────────────────────────────
  console.log("A. Per-phone token bucket");
  // 60/s — the case the old sleep never bound (batchSize 50 < rate 60 ⇒ one
  // slice per batch ⇒ the sleep's 833ms target never exceeded the 2,482ms cycle).
  await assertRate(60, 60, 10);
  // 3/s — the case the old sleep DID bind (measured p50 1.006s slice gaps); the
  // replacement must not regress it.
  await assertRate(3, 3, 10);
  // A slice smaller than the rate still paces proportionally.
  await assertRate(60, 10, 30);
  // Burst bound, emitted the way the drain emits (whole slice at once).
  await assertSlidingWindow(60, 10);
  await assertSlidingWindow(3, 10);
  await assertSlidingWindow(10, 10);
  {
    // A single take LARGER than the rate must occupy proportional time, not fire
    // a 10-second burst in one instant.
    const clock = virtualClock();
    const b = makeTokenBucket(60, { now: clock.now, sleep: clock.sleep });
    await b.take(600); // first take is free (bucket starts at `now`)
    await b.take(60);
    check(
      "a take larger than the rate reserves proportional time (600 @ 60/s ⇒ next waits 10s)",
      clock.t === 10_000,
      `t=${clock.t}`,
    );
  }
  {
    // Idle time must NOT be bankable — otherwise a quiet minute would be cashed
    // in as a 60× burst the carrier would reject.
    const clock = virtualClock();
    const b = makeTokenBucket(10, { now: clock.now, sleep: clock.sleep });
    await b.take(10); // t=0
    clock.advance(60_000); // one idle minute
    await b.take(10); // immediate (credit not banked, just not owed)
    const before = clock.t;
    await b.take(10); // must still wait a full second
    check(
      "idle time is not banked as burst credit (next take still waits 1s)",
      clock.t - before === 1000,
      `waited ${clock.t - before}ms`,
    );
  }
  {
    // CONCURRENT consumers (the same-phone multi-stage case) share the ceiling:
    // reservations are synchronous, so two interleaved stages cannot both claim
    // the same second.
    const clock = virtualClock();
    const b = makeTokenBucket(10, { now: clock.now, sleep: clock.sleep });
    let emitted = 0;
    const stage = async () => {
      for (let i = 0; i < 5; i++) {
        await b.take(5);
        emitted += 5;
      }
    };
    await Promise.all([stage(), stage()]);
    check(
      "two stages sharing ONE bucket emit at the phone's rate, not 2×",
      emitted === 50 && clock.t >= ((50 - 10) / 10) * 1000,
      `emitted=${emitted} t=${clock.t}ms (need >= 4000)`,
    );
  }

  // ── B. Batch sizing ────────────────────────────────────────────────────────
  console.log("\nB. Batch size derives from the phone's rate");
  check("60/s ⇒ 600 rows (~10s of sending, preamble ~19% overhead)", resolveDrainBatchSize(60) === 600, `${resolveDrainBatchSize(60)}`);
  check("3/s ⇒ floored at MIN_DRAIN_BATCH", resolveDrainBatchSize(3) === MIN_DRAIN_BATCH, `${resolveDrainBatchSize(3)}`);
  check("10/s (default) ⇒ 100", resolveDrainBatchSize(10) === 100, `${resolveDrainBatchSize(10)}`);
  check("1000/s ⇒ clamped to MAX_DRAIN_BATCH", resolveDrainBatchSize(1000) === MAX_DRAIN_BATCH, `${resolveDrainBatchSize(1000)}`);
  check("never below the old fixed 50", resolveDrainBatchSize(1) >= 50, `${resolveDrainBatchSize(1)}`);

  let n = 0;
  const uniq = () => `${Date.now()}-${n++}`;
  let pnSeq = 3_000_000;
  const mkNumber = () => `+1555${pnSeq++}`;

  try {
    await db.transaction(async (tx) => {
      const dbc = tx as unknown as typeof db;
      const one = async <T>(q: ReturnType<typeof sql>) =>
        ((await tx.execute(q)) as unknown as T[])[0];

      const mkFixture = async () => {
        const org = await one<{ id: string }>(sql`
          INSERT INTO organizations (name) VALUES (${`dt-${uniq()}`}) RETURNING id
        `);
        const orgId = org.id;
        await tx.execute(sql`
          INSERT INTO org_settings (org_id, sends_enabled) VALUES (${orgId}, true)
          ON CONFLICT (org_id) DO UPDATE SET sends_enabled = true
        `);
        const brand = await one<{ id: number }>(sql`
          INSERT INTO brands (org_id, brand_id, name)
          VALUES (${orgId}, ${`b-${uniq()}`}, ${"B"}) RETURNING id
        `);
        const camp = await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, brand_id, link_mode, status)
          VALUES (${orgId}, ${`c-${uniq()}`}, ${brand.id}, 'tracked', 'active') RETURNING id
        `);
        const mkProvider = async (maxRun: number | null) =>
          (await one<{ id: number }>(sql`
            INSERT INTO sms_providers
              (sms_provider_id, org_id, name, supports_api_send, status, max_sends_per_run,
               max_sends_per_minute, max_sends_per_24h,
               send_window_weekday_start, send_window_weekday_end,
               send_window_weekend_start, send_window_weekend_end)
            VALUES (${`p-${uniq()}`}, ${orgId}, ${"P"}, true, 'active', ${maxRun},
                    100000, 100000, 0, 1439, 0, 1439)
            RETURNING id
          `)).id;
        const addCred = async (providerId: number) =>
          tx.execute(sql`
            INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
            VALUES (${orgId}, ${providerId}, NULL, ${"key"})
          `);
        const mkPhone = async (providerId: number, rate: number | null) =>
          (await one<{ id: number }>(sql`
            INSERT INTO provider_phones (org_id, provider_id, phone_number, max_sends_per_second)
            VALUES (${orgId}, ${providerId}, ${mkNumber()}, ${rate})
            RETURNING id
          `)).id;
        let stageSeq = 0;
        // `phones` lets a case control the recipient numbers (the dedup key);
        // otherwise every row gets a unique one.
        const mkStage = async (
          providerId: number,
          phoneId: number | null,
          rows: number,
          text: string,
          phones?: string[],
        ) => {
          const st = await one<{ id: number }>(sql`
            INSERT INTO campaign_stages
              (org_id, campaign_id, stage_number, sms_provider_id, provider_phone_id,
               send_approved, scheduled_at, materialized_at)
            VALUES (${orgId}, ${camp.id}, ${stageSeq++}, ${providerId}, ${phoneId},
                    true, ${SCHEDULED_AT}, now())
            RETURNING id
          `);
          for (let i = 0; i < rows; i++) {
            const contact = await one<{ id: string }>(sql`
              INSERT INTO contacts (org_id, phone_number)
              VALUES (${orgId}, ${mkNumber()}) RETURNING id
            `);
            await tx.execute(sql`
              INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
              VALUES (${orgId}, ${camp.id}, ${st.id}, ${contact.id},
                      ${phones?.[i] ?? mkNumber()}, ${text}, 'pending')
            `);
          }
          return st.id;
        };
        return { orgId, campaignId: camp.id, mkProvider, addCred, mkPhone, mkStage };
      };

      // ── C. 24h-count memo ────────────────────────────────────────────────
      console.log("\nC. Per-invocation 24h-count memo");
      {
        const f = await mkFixture();
        const provA = await f.mkProvider(100_000);
        const provB = await f.mkProvider(100_000);
        await f.addCred(provA);
        await f.addCred(provB);
        const phA = await f.mkPhone(provA, 60);
        const stA = await f.mkStage(provA, phA, 3, "memo");
        // Mark provider A's three rows as sent so the 24h count sees them.
        await tx.execute(sql`
          UPDATE stage_sends SET status = 'sent', sent_at = now() WHERE stage_id = ${stA}
        `);

        let hits = 0;
        const counting = {
          execute: (q: unknown) => {
            hits++;
            return (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(q);
          },
        } as unknown as typeof db;

        const memo = makeSentSinceMemo();
        const a1 = await memo.count(counting, f.orgId, provA, 86_400, 100_000);
        check("first read hits the DB and returns provider A's own count", a1 === 3 && hits === 1, `v=${a1} hits=${hits}`);
        const a2 = await memo.count(counting, f.orgId, provA, 86_400, 100_000);
        check("second read is served from the memo (no extra round-trip)", a2 === 3 && hits === 1, `v=${a2} hits=${hits}`);
        const b1 = await memo.count(counting, f.orgId, provB, 86_400, 100_000);
        check(
          "PER-PROVIDER scoping preserved — provider B is 0, NOT A's 3 (ClickUp 869e659t4)",
          b1 === 0 && hits === 2,
          `v=${b1} hits=${hits}`,
        );
        memo.addSent(f.orgId, provA, 7);
        const a3 = await memo.count(counting, f.orgId, provA, 86_400, 100_000);
        check("locally-emitted sends fold in (self-throttling preserved)", a3 === 10 && hits === 2, `v=${a3} hits=${hits}`);
        const near = await memo.count(counting, f.orgId, provA, 86_400, 10);
        check("near the cap the memo is bypassed for a fresh read", near === 3 && hits === 3, `v=${near} hits=${hits}`);
      }

      // ── D/E/F. Same-phone concurrency: rate, no starvation, dedup, no dupes ──
      console.log("\nD/E/F. Same-phone multi-stage drain (real drain, injected sender)");
      {
        const f = await mkFixture();
        const prov = await f.mkProvider(100_000);
        await f.addCred(prov);
        const RATE = 10;
        const ph = await f.mkPhone(prov, RATE);
        // A number that appears in BOTH stages — the cross-stage dedup probe.
        const shared = mkNumber();
        const s1Phones = [shared, ...Array.from({ length: 14 }, mkNumber)];
        const s2Phones = [shared, ...Array.from({ length: 14 }, mkNumber)];
        await f.mkStage(prov, ph, 15, "s1", s1Phones);
        await f.mkStage(prov, ph, 15, "s2", s2Phones);

        const dispatched: { at: number; tag: string; number: string }[] = [];
        const t0 = Date.now();
        const sender: Sender = async ({ text, number }) => {
          dispatched.push({ at: Date.now() - t0, tag: text, number });
          return {
            ok: true, messageId: `m-${dispatched.length}`, response: "queued",
            providerStatus: null, suppressed: false, rawBody: '{"id":"m"}',
            error: null, status: 200, timedOut: false, latencyMs: 7,
          };
        };

        const res = await runScheduledSends(dbc, {
          orgId: f.orgId, now: NOW, isEnabled: () => true, isOrgEnabled: async () => true,
          sendSms: sender, maxStages: 50,
        });
        const elapsed = Date.now() - t0;

        // E — the shared number is sent ONCE across the two concurrent stages.
        check("cross-stage duplicate number dispatched exactly once", dispatched.filter((d) => d.number === shared).length === 1,
          `${dispatched.filter((d) => d.number === shared).length}×`);
        check("the duplicate's other row is skipped_duplicate", res.skipped_duplicate === 1, JSON.stringify(res));
        const dupRows = await one<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM stage_sends
          WHERE org_id = ${f.orgId} AND phone = ${shared} AND status = 'skipped_duplicate'
        `);
        check("the skipped row is terminal in the DB", Number(dupRows.n) === 1, JSON.stringify(dupRows));

        // F — one dispatch per row, exactly once.
        check("29 unique numbers dispatched (30 rows − 1 dedup)", dispatched.length === 29, `${dispatched.length}`);
        check("no number dispatched twice", new Set(dispatched.map((d) => d.number)).size === dispatched.length);
        check("every send accounted for as 'sent'", res.sent === 29, JSON.stringify(res));
        const attempts = await one<{ maxAttempts: number; sent: number }>(sql`
          SELECT COALESCE(max(attempts), 0)::int AS "maxAttempts",
                 count(*) FILTER (WHERE status = 'sent')::int AS sent
          FROM stage_sends WHERE org_id = ${f.orgId}
        `);
        check("no row attempted more than once (at-most-once held)", Number(attempts.maxAttempts) === 1, JSON.stringify(attempts));
        check("DB 'sent' count matches the dispatch count", Number(attempts.sent) === 29, JSON.stringify(attempts));

        // D — both stages progressed (no starvation) AND the phone's rate held.
        const s1 = dispatched.filter((d) => d.tag === "s1").length;
        const s2 = dispatched.filter((d) => d.tag === "s2").length;
        check("BOTH same-phone stages made progress (no starvation)", s1 > 0 && s2 > 0, `s1=${s1} s2=${s2}`);
        const firstS2 = dispatched.findIndex((d) => d.tag === "s2");
        const lastS1 = dispatched.map((d) => d.tag).lastIndexOf("s1");
        check("their sends INTERLEAVE (concurrent, not one stage then the other)", firstS2 < lastS1,
          `firstS2=${firstS2} lastS1=${lastS1}`);
        // The shared bucket must cap the NUMBER, not each stage: 29 sends at 10/s
        // cannot finish faster than (29 − 10)/10 s even with two stages running.
        const floorMs = ((dispatched.length - RATE) / RATE) * 1000;
        check(
          `per-phone MPS never exceeded — ${dispatched.length} sends took ${elapsed}ms (>= ${floorMs}ms at ${RATE}/s)`,
          elapsed >= floorMs,
          `elapsed=${elapsed} floor=${floorMs}`,
        );
        // SLIDING-window bound on the REAL dispatch timestamps. A slice is fired
        // as one burst and then paced, so a window straddling two slice
        // boundaries can hold up to 2 x rate — the shape the drain has always
        // had, unchanged here (smoothing it costs ~40% throughput until writes
        // are pipelined; see lib/sends/token-bucket.ts). What must NOT happen is
        // slices bunching further than that.
        const worstWindow = worstSlidingWindow(dispatched.map((d) => d.at));
        check(
          `sliding 1s window never exceeds one slice of burst ahead (worst ${worstWindow} <= ${2 * RATE})`,
          worstWindow <= 2 * RATE,
          `worst=${worstWindow}`,
        );
      }

      // ── G. Slice-boundary yield returns undispatched rows to 'pending' ──────
      console.log("\nG. Slice-boundary yield never strands claimed rows");
      {
        const f = await mkFixture();
        const prov = await f.mkProvider(100_000);
        await f.addCred(prov);
        const ph = await f.mkPhone(prov, 5);
        const st = await f.mkStage(prov, ph, 30, "yield");
        const sender: Sender = async () => ({
          ok: true, messageId: "y", response: "queued", providerStatus: null,
          suppressed: false, rawBody: "{}", error: null, status: 200,
          timedOut: false, latencyMs: 1,
        });
        // batchSize 50 claims all 30 at once; a 1.5s time-box at 5/s yields after
        // ~2 slices, leaving ~20 claimed-but-undispatched rows.
        const r = await runStageDrain(tx, {
          stageId: st, sendSms: sender, isEnabled: () => true, isOrgEnabled: async () => true,
          batchSize: 50, maxDurationMs: 1500,
        });
        check("yielded with work left", r.ok && r.sent > 0 && r.sent < 30, JSON.stringify({ sent: r.sent, remaining: r.remaining }));
        check("soft yield (not halted, no stopReason)", r.halted === false && r.stopReason == null, JSON.stringify(r));
        check("ZERO rows stranded in 'sending'", r.stuck === 0, `stuck=${r.stuck}`);
        check("undispatched rows returned to 'pending'", r.sent + r.remaining === 30, `${r.sent}+${r.remaining}`);
        const dbCounts = await one<{ pending: number; sending: number; sent: number }>(sql`
          SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
                 count(*) FILTER (WHERE status = 'sending')::int AS sending,
                 count(*) FILTER (WHERE status = 'sent')::int    AS sent
          FROM stage_sends WHERE stage_id = ${st}
        `);
        check("DB agrees: nothing left 'sending'", Number(dbCounts.sending) === 0, JSON.stringify(dbCounts));
        check("DB agrees: pending + sent = 30", Number(dbCounts.pending) + Number(dbCounts.sent) === 30, JSON.stringify(dbCounts));
      }

      console.log("\nAll cases done. Rolling back (no data persisted).");
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) {
      console.error("\nCRASHED:", err);
      failed = failed || 1;
    }
  } finally {
    await pgConn.end({ timeout: 5 });
  }

  if (failed) {
    console.log(`\nFAILED: ${failed} check(s).`);
    process.exit(1);
  }
  console.log("\ntest-drain-throughput OK.");
}

main().catch((err) => {
  console.error("crashed:", err);
  process.exit(1);
});
