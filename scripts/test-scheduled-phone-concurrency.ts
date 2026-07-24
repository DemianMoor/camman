// Phase 1+2 verification for the send-scheduled cron's Phase B:
//   • phone-PARTITIONED CONCURRENT drain — stages on DIFFERENT phones drain in
//     parallel (a slow phone never blocks a fast one on another number),
//   • round-robin WITHIN a phone — a stage with more pending than one fairness
//     slice is revisited in the same tick, sharing the phone with its siblings,
//   • per-provider per-tick budget stays a hard ceiling under concurrency.
//
// Everything runs inside ONE transaction that is ALWAYS rolled back (throwaway
// orgs, one per case for isolation). The drain is INJECTED (a deterministic fake
// that tracks concurrency + simulated remaining) — no real send, SEND_ENABLED
// irrelevant. We assert the ORCHESTRATION (what runs in parallel, how budget is
// shared), not the real send mechanics (verify-drain.ts covers those).
//
// Run: npx tsx scripts/test-scheduled-phone-concurrency.ts
import "./_env-preload"; // MUST be first — loads .env.local before db/client init
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import type { DrainResult } from "@/lib/sends/drain";
import { runScheduledSends } from "@/lib/sends/scheduled";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

// A weekday-noon-ET instant; the fixtures use an all-day send window so `now` is
// always in-window and scheduled_at (now − 60s) decides "fire".
const NOW = new Date("2026-06-15T16:00:00Z");
const SCHEDULED_AT = new Date("2026-06-15T15:59:00Z").toISOString();

const ROLLBACK = Symbol("rollback");

// Build a DrainResult from a processed count (the only fields Phase B reads:
// sent/failed/skipped*/processed/remaining/ok/halted/pausedNow).
function drained(processed: number, remaining: number, extra?: Partial<DrainResult>): DrainResult {
  return {
    ok: true, sent: processed, failed: 0, filtered: 0, skippedDuplicate: 0,
    skippedOptedOut: 0, processed, halted: false, stuck: 0, remaining,
    stopReason: null, pausedNow: false, ...extra,
  };
}

async function main() {
  let n = 0;
  const uniq = () => `${Date.now()}-${n++}`;
  // Monotonic E.164-ish number generator: '+1555' + 7 digits = 12 chars, unique
  // by increment (a timestamp-based number collided within the same millisecond).
  let pnSeq = 1_000_000;
  const mkNumber = () => `+1555${pnSeq++}`;

  try {
    await db.transaction(async (tx) => {
      const dbc = tx as unknown as typeof db;
      const one = async <T>(q: ReturnType<typeof sql>) =>
        ((await tx.execute(q)) as unknown as T[])[0];

      // A self-contained fixture bound to a FRESH org so each case's
      // selectDrainableStages only sees its own stages (scoped by orgId).
      const mkFixture = async () => {
        const org = await one<{ id: string }>(sql`
          INSERT INTO organizations (name) VALUES (${`pc-${uniq()}`}) RETURNING id
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
               send_window_weekday_start, send_window_weekday_end,
               send_window_weekend_start, send_window_weekend_end)
            VALUES (${`p-${uniq()}`}, ${orgId}, ${"P"}, true, 'active', ${maxRun},
                    0, 1439, 0, 1439)
            RETURNING id
          `)).id;
        const mkPhone = async (providerId: number, rate: number | null) =>
          (await one<{ id: number }>(sql`
            INSERT INTO provider_phones (org_id, provider_id, phone_number, max_sends_per_second)
            VALUES (${orgId}, ${providerId}, ${mkNumber()}, ${rate})
            RETURNING id
          `)).id;
        let stageSeq = 0;
        // A drainable stage: approved, materialized (so Phase A skips + Phase B
        // drains it), due (scheduled_at in the past), first-fire (sent_at NULL),
        // with `pending` rows so selectDrainableStages picks it up.
        const mkStage = async (providerId: number, phoneId: number, pendingRows: number) => {
          const st = await one<{ id: number }>(sql`
            INSERT INTO campaign_stages
              (org_id, campaign_id, stage_number, sms_provider_id, provider_phone_id,
               send_approved, scheduled_at, materialized_at)
            VALUES (${orgId}, ${camp.id}, ${stageSeq++}, ${providerId}, ${phoneId},
                    true, ${SCHEDULED_AT}, now())
            RETURNING id
          `);
          for (let i = 0; i < pendingRows; i++) {
            const contact = await one<{ id: string }>(sql`
              INSERT INTO contacts (org_id, phone_number)
              VALUES (${orgId}, ${mkNumber()}) RETURNING id
            `);
            await tx.execute(sql`
              INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
              VALUES (${orgId}, ${camp.id}, ${st.id}, ${contact.id},
                      ${mkNumber()}, ${"m"}, 'pending')
            `);
          }
          return st.id;
        };
        return { orgId, mkProvider, mkPhone, mkStage };
      };

      const runTick = (orgId: string, runDrain: (s: number, r: number, d?: number) => Promise<DrainResult>) =>
        runScheduledSends(dbc, {
          orgId, now: NOW, isEnabled: () => true, isOrgEnabled: async () => true,
          runDrain, maxStages: 50,
        });

      // A BARRIER fake: each call holds until `parties` calls are simultaneously
      // in flight (then all release), or a per-call timeout fires. Concurrent
      // drains reach the barrier together → it releases → maxInFlight = parties.
      // Sequential drains reach it one at a time → each times out → maxInFlight 1.
      // This makes the concurrency observable WITHOUT depending on DB-vs-timer race
      // ordering (a plain setImmediate hold was defeated by DB round-trip latency).
      const makeBarrierFake = (rem: Map<number, number>, parties: number, timeoutMs: number) => {
        let inFlight = 0, maxInFlight = 0, entered = 0;
        let release: () => void = () => {};
        const barrier = new Promise<void>((r) => { release = r; });
        const fake = async (stageId: number, maxRows: number) => {
          inFlight++; entered++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (entered >= parties) release();
          await Promise.race([barrier, new Promise((r) => setTimeout(r, timeoutMs))]);
          inFlight--;
          const r0 = rem.get(stageId) ?? 0;
          const p = Math.max(0, Math.min(maxRows, r0));
          rem.set(stageId, r0 - p);
          return drained(p, r0 - p);
        };
        return { fake, max: () => maxInFlight };
      };

      // ── Case 1: two phones drain CONCURRENTLY (the Phase-1 property) ──────────
      console.log("Case 1: stages on different phones drain in parallel");
      {
        const f = await mkFixture();
        const prov = await f.mkProvider(100_000); // high cap — not the limiter here
        const ph1 = await f.mkPhone(prov, 60);
        const ph2 = await f.mkPhone(prov, 60);
        const s1 = await f.mkStage(prov, ph1, 1);
        const s2 = await f.mkStage(prov, ph2, 1);
        const bf = makeBarrierFake(new Map([[s1, 1], [s2, 1]]), 2, 2000);
        const res = await runTick(f.orgId, bf.fake);
        check("both stages drained", res.drained === 2, JSON.stringify(res));
        check("both sent (1 each)", res.sent === 2, JSON.stringify(res));
        check("drains OVERLAPPED — maxInFlight 2 (concurrent by phone)", bf.max() === 2, `maxInFlight=${bf.max()}`);
      }

      // ── Case 2: two stages on the SAME phone drain SEQUENTIALLY ───────────────
      console.log("Case 2: stages on one phone drain sequentially (shared carrier rate)");
      {
        const f = await mkFixture();
        const prov = await f.mkProvider(100_000);
        const ph = await f.mkPhone(prov, 60);
        const s1 = await f.mkStage(prov, ph, 1);
        const s2 = await f.mkStage(prov, ph, 1);
        // parties=2 can NEVER be met (one phone group = one drain at a time), so the
        // first call times out (300ms) then the second releases — maxInFlight 1.
        const bf = makeBarrierFake(new Map([[s1, 1], [s2, 1]]), 2, 300);
        const res = await runTick(f.orgId, bf.fake);
        check("both same-phone stages drained", res.drained === 2, JSON.stringify(res));
        check("drains did NOT overlap — maxInFlight 1 (sequential within phone)", bf.max() === 1, `maxInFlight=${bf.max()}`);
      }

      // ── Case 3: round-robin WITHIN a phone (revisit until drained) ────────────
      console.log("Case 3: a big stage is revisited in-tick (round-robin), not drained in one shot");
      {
        const f = await mkFixture();
        const prov = await f.mkProvider(100_000);
        const ph = await f.mkPhone(prov, 60);
        const s1 = await f.mkStage(prov, ph, 1);
        // Simulate a stage that needs 3 slices: the fake drains 3 "rows" per call
        // and reports the shrinking remaining, so drainStageSlice revisits.
        const rem = new Map<number, number>([[s1, 8]]);
        const callsByStage = new Map<number, number>();
        const fake = async (stageId: number) => {
          callsByStage.set(stageId, (callsByStage.get(stageId) ?? 0) + 1);
          const r0 = rem.get(stageId) ?? 0;
          const p = Math.min(3, r0);
          rem.set(stageId, r0 - p);
          return drained(p, r0 - p);
        };
        const res = await runTick(f.orgId, fake);
        check("stage fully drained across slices (sent 8)", res.sent === 8, JSON.stringify(res));
        check("drained counts the stage ONCE (distinct)", res.drained === 1, JSON.stringify(res));
        check("round-robin revisited the stage 3× (ceil 8/3)", callsByStage.get(s1) === 3, `calls=${callsByStage.get(s1)}`);
      }

      // ── Case 4: per-provider per-tick budget is a hard ceiling ────────────────
      console.log("Case 4: provider per-tick budget caps total sends under revisits");
      {
        const f = await mkFixture();
        const prov = await f.mkProvider(10); // cap 10 rows/tick for the whole provider
        const ph = await f.mkPhone(prov, 60);
        const s1 = await f.mkStage(prov, ph, 1);
        // Stage "wants" 100; the fake drains exactly what it's granted each slice.
        const rem = new Map<number, number>([[s1, 100]]);
        const fake = async (stageId: number, maxRows: number) => {
          const r0 = rem.get(stageId) ?? 0;
          const p = Math.max(0, Math.min(maxRows, r0));
          rem.set(stageId, r0 - p);
          return drained(p, r0 - p);
        };
        const res = await runTick(f.orgId, fake);
        check("provider budget capped the tick at 10", res.sent === 10, JSON.stringify(res));
        check("budget exhaustion recorded (budget_held ≥ 1)", res.budget_held >= 1, JSON.stringify(res));
      }

      console.log("\nAll cases done. Rolling back (no data persisted).");
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) { console.error("\nCRASHED:", err); failed = 1; }
  } finally {
    await pgConn.end({ timeout: 5 });
  }

  if (failed) { console.log(`\nFAILED: ${failed} check(s).`); process.exit(1); }
  console.log("\ntest-scheduled-phone-concurrency OK.");
}

main().catch((err) => { console.error("crashed:", err); process.exit(1); });
