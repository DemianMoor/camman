// Per-phone drain lease (fix/send-scheduled-lease): the send-scheduled cron took
// NO lease, so an overrunning tick overlapped the next one and two drain loops
// could send on the SAME number at once — the per-phone `max_sends_per_second`
// pacing is per-invocation, so N overlapping invocations multiply the effective
// MPS by N (a carrier-compliance exposure).
//
// Asserts the four properties the guard must have:
//   1. two CONCURRENT drains of the SAME phone → exactly one proceeds,
//   2. DIFFERENT phones still drain in PARALLEL (the 2026-07-24 head-of-line fix
//      must not regress into a global single-runner),
//   3. a RELEASED lease is immediately reacquirable (clean exit doesn't wedge),
//   4. an EXPIRED lease is reacquirable (a crashed run self-heals), and
//   5. a HELD lease SKIPS CLEANLY — no throw, nothing marked missed, rows stay
//      'pending' for the next tick.
//
// Everything runs inside ONE transaction that is ALWAYS rolled back (throwaway
// orgs, one per case). The drain is INJECTED (a deterministic fake) — no real
// send, SEND_ENABLED irrelevant. Mirrors scripts/test-scheduled-phone-concurrency.ts.
//
// Run: npx tsx scripts/test-phone-drain-lease.ts
import "./_env-preload"; // MUST be first — loads .env.local before db/client init
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import type { DrainResult } from "@/lib/sends/drain";
import { phoneDrainLeaseKey, runScheduledSends } from "@/lib/sends/scheduled";

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

function drained(processed: number, remaining: number): DrainResult {
  return {
    ok: true, sent: processed, failed: 0, filtered: 0, skippedDuplicate: 0,
    skippedOptedOut: 0, processed, halted: false, stuck: 0, remaining,
    stopReason: null, pausedNow: false,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let n = 0;
  const uniq = () => `${Date.now()}-${n++}`;
  let pnSeq = 2_000_000;
  const mkNumber = () => `+1555${pnSeq++}`;

  try {
    await db.transaction(async (tx) => {
      const dbc = tx as unknown as typeof db;
      const one = async <T>(q: ReturnType<typeof sql>) =>
        ((await tx.execute(q)) as unknown as T[])[0];

      const mkFixture = async () => {
        const org = await one<{ id: string }>(sql`
          INSERT INTO organizations (name) VALUES (${`pl-${uniq()}`}) RETURNING id
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

      // ── Case 1: two CONCURRENT drains of the SAME phone — only one proceeds ──
      console.log("Case 1: concurrent invocations on ONE phone — exactly one drains");
      {
        const f = await mkFixture();
        const prov = await f.mkProvider(100_000);
        const ph = await f.mkPhone(prov, 60);
        await f.mkStage(prov, ph, 1);

        // The winner's drain HOLDS until the loser's whole run has settled, so the
        // loser necessarily attempts the lease while it is held.
        let release: () => void = () => {};
        const hold = new Promise<void>((r) => { release = r; });
        let drainCalls = 0;
        const fake = async () => {
          drainCalls++;
          await Promise.race([hold, sleep(5_000)]);
          return drained(1, 0);
        };
        const pA = runTick(f.orgId, fake).then((r) => { release(); return r; });
        const pB = runTick(f.orgId, fake).then((r) => { release(); return r; });
        const [a, b] = await Promise.all([pA, pB]);

        const winners = [a, b].filter((r) => r.drained === 1);
        const skippers = [a, b].filter((r) => r.phone_lease_skipped === 1);
        check("exactly ONE invocation drained the phone", winners.length === 1,
          `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
        check("the other invocation recorded phone_lease_skipped=1", skippers.length === 1,
          `a=${a.phone_lease_skipped} b=${b.phone_lease_skipped}`);
        check("the skipper drained nothing", skippers[0]?.drained === 0, JSON.stringify(skippers[0]));
        check("the drain ran ONCE, not twice (no doubled MPS on the number)", drainCalls === 1,
          `drainCalls=${drainCalls}`);
        check("total sent counted once across both invocations", a.sent + b.sent === 1,
          `${a.sent}+${b.sent}`);
      }

      // ── Case 2: DIFFERENT phones still drain in PARALLEL ─────────────────────
      console.log("Case 2: leases are per-PHONE — different numbers still drain concurrently");
      {
        const f = await mkFixture();
        const prov = await f.mkProvider(100_000);
        const ph1 = await f.mkPhone(prov, 60);
        const ph2 = await f.mkPhone(prov, 60);
        await f.mkStage(prov, ph1, 1);
        await f.mkStage(prov, ph2, 1);

        // Barrier fake: releases only once BOTH groups are simultaneously in
        // flight. A global (per-job) lease would deadlock this into maxInFlight 1.
        let inFlight = 0, maxInFlight = 0, entered = 0;
        let release: () => void = () => {};
        const barrier = new Promise<void>((r) => { release = r; });
        const fake = async () => {
          inFlight++; entered++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (entered >= 2) release();
          await Promise.race([barrier, sleep(2_000)]);
          inFlight--;
          return drained(1, 0);
        };
        const res = await runTick(f.orgId, fake);
        check("both phones drained", res.drained === 2, JSON.stringify(res));
        check("no lease contention between different phones", res.phone_lease_skipped === 0, JSON.stringify(res));
        check("drains OVERLAPPED — maxInFlight 2 (per-phone, not global)", maxInFlight === 2,
          `maxInFlight=${maxInFlight}`);
      }

      // ── Case 3: a RELEASED lease is immediately reacquirable ─────────────────
      console.log("Case 3: a cleanly-released lease is reacquirable on the next tick");
      {
        const f = await mkFixture();
        const prov = await f.mkProvider(100_000);
        const ph = await f.mkPhone(prov, 60);
        const st = await f.mkStage(prov, ph, 1);
        const fake = async () => drained(1, 0);
        const r1 = await runTick(f.orgId, fake);
        const key = phoneDrainLeaseKey(ph, st);
        const lock = await one<{ lease_until: string | null }>(sql`
          SELECT lease_until FROM cron_locks WHERE job_name = ${key}
        `);
        check("tick 1 drained", r1.drained === 1, JSON.stringify(r1));
        check("lease CLEARED on clean exit (lease_until IS NULL)", lock?.lease_until === null,
          JSON.stringify(lock));
        const r2 = await runTick(f.orgId, fake);
        check("tick 2 reacquired and drained again", r2.drained === 1 && r2.phone_lease_skipped === 0,
          JSON.stringify(r2));
      }

      // ── Case 4: an EXPIRED lease is reacquirable (crash self-heals) ──────────
      console.log("Case 4: an EXPIRED lease (crashed run) is reclaimed by the next tick");
      {
        const f = await mkFixture();
        const prov = await f.mkProvider(100_000);
        const ph = await f.mkPhone(prov, 60);
        const st = await f.mkStage(prov, ph, 1);
        const key = phoneDrainLeaseKey(ph, st);
        // Simulate a run that was hard-killed while holding the lease: the row is
        // left with a lease_until in the past (no release ever ran).
        await tx.execute(sql`
          INSERT INTO cron_locks (job_name, lease_until)
          VALUES (${key}, now() - interval '1 minute')
          ON CONFLICT (job_name) DO UPDATE SET lease_until = now() - interval '1 minute'
        `);
        const res = await runTick(f.orgId, async () => drained(1, 0));
        check("expired lease reclaimed — the phone drained", res.drained === 1, JSON.stringify(res));
        check("no skip recorded for an expired lease", res.phone_lease_skipped === 0, JSON.stringify(res));
      }

      // ── Case 5: a HELD lease SKIPS CLEANLY ──────────────────────────────────
      console.log("Case 5: a held lease skips the phone cleanly (no error, nothing missed)");
      {
        const f = await mkFixture();
        const prov = await f.mkProvider(100_000);
        const ph = await f.mkPhone(prov, 60);
        const st = await f.mkStage(prov, ph, 2);
        const key = phoneDrainLeaseKey(ph, st);
        await tx.execute(sql`
          INSERT INTO cron_locks (job_name, lease_until)
          VALUES (${key}, now() + interval '10 minutes')
          ON CONFLICT (job_name) DO UPDATE SET lease_until = now() + interval '10 minutes'
        `);
        let called = 0;
        const res = await runTick(f.orgId, async () => { called++; return drained(2, 0); });
        check("the drain was NOT invoked for the leased phone", called === 0, `called=${called}`);
        check("run completed without error, drained 0", res.drained === 0 && res.sent === 0, JSON.stringify(res));
        check("skip counted (phone_lease_skipped=1)", res.phone_lease_skipped === 1, JSON.stringify(res));
        const stage = await one<{ schedule_missed_at: string | null; sent_at: string | null }>(sql`
          SELECT schedule_missed_at, sent_at FROM campaign_stages WHERE id = ${st}
        `);
        check("stage NOT marked missed", stage.schedule_missed_at === null, JSON.stringify(stage));
        check("stage NOT falsely released (sent_at still NULL)", stage.sent_at === null, JSON.stringify(stage));
        const pend = await one<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM stage_sends WHERE stage_id = ${st} AND status = 'pending'
        `);
        check("rows stay 'pending' for the next tick", Number(pend.n) === 2, JSON.stringify(pend));
        const lock = await one<{ skipped_count: number; lease_until: string | null }>(sql`
          SELECT skipped_count, lease_until FROM cron_locks WHERE job_name = ${key}
        `);
        check("skip recorded on the lease row (skipped_count=1)", Number(lock.skipped_count) === 1,
          JSON.stringify(lock));
        check("the holder's lease was NOT stolen or cleared", lock.lease_until !== null, JSON.stringify(lock));
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
  console.log("\ntest-phone-drain-lease OK.");
}

main().catch((err) => { console.error("crashed:", err); process.exit(1); });
