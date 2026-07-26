import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

// Small, deterministic thresholds (the breaker reads process.env per call, so
// this also exercises the env-tunability): 10-send floors, 10%/8% trips,
// 24h long window + 2h short twin.
process.env.OPTOUT_RATE_MIN_SENDS = "10";
process.env.OPTOUT_RATE_SPIKE_THRESHOLD = "0.10";
process.env.OPTOUT_RATE_WINDOW_SEC = "86400";
process.env.OPTOUT_RATE_MIN_SENDS_SHORT = "10";
process.env.OPTOUT_RATE_SPIKE_THRESHOLD_SHORT = "0.08";
process.env.OPTOUT_RATE_WINDOW_SHORT_SEC = "7200";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { db as dbType } from "@/db/client";
import { isCampaignPaused, latchCampaignPause } from "@/lib/sends/circuit-breakers";
import { checkOptOutRateBreaker } from "@/lib/sends/optout-rate-breaker";
import { selectDueScheduledStages } from "@/lib/sends/scheduled";
import { findStalledStages } from "@/lib/sends/stall-detector";
import { findUnjoinableOptOutAttributions } from "@/lib/sends/unjoinable-attributions";

// Verifies P7/P8 — the per-campaign opt-out-rate breaker (migration 0119) as
// re-cut on 2026-07-26 (docs/optout-rate-breaker-false-trip-2026-07-25.md):
//    1. FLOOR: no trip below the min-send floor.
//    2. TRIP (long window): rate over threshold + floor cleared → latch + audit.
//    3. UNDER threshold → no trip.
//    4. THE FALSE-TRIP REGRESSION: an old blast's STOPs still arriving, plus a
//       small new send. Receipt-time bucketing trips at >100%; the ALIGNED
//       cohort must not trip at all. This is the whole point of the change.
//    5. SHORT-WINDOW TWIN: a fresh toxic send trips the 2h window while the 24h
//       window stays quiet.
//    6. NULL stage_send_id rows are EXCLUDED from the numerator.
//    7. PER-STAGE ISOLATION: a hot stage trips even though a sibling stage's
//       volume would dilute it to safe at campaign level.
//    8. UNJOINABLE detector counts null-stage_send_id attributions.
//    9. ANDed GATE: a campaign pause excludes only THAT campaign from the
//       scheduler; a sibling on the same provider still selects, and the
//       provider latch is untouched.
//   10. STALL-detector excludes a campaign-paused stage.
//   11. RESUME + idempotency: latch is one-shot; clearing send_paused re-arms.
//
// Rolled-back tx, no real provider. Requires migration 0119.
// The pure decision math + UI states are covered offline by
// scripts/test-optout-breaker-decision.ts (no database needed).
//
// Run: npx tsx scripts/test-optout-rate-breaker.ts

class Rollback extends Error {}
let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${msg}`);
  if (cond) pass++;
  else fail++;
}

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);
  try {
    await db.transaction(async (tx) => {
      const T = tx as unknown as typeof dbType;
      const one = async <X>(q: Parameters<typeof tx.execute>[0]): Promise<X> =>
        ((await tx.execute(q)) as unknown as X[])[0];

      const orgId = (await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`)).id;
      await tx.execute(sql`
        INSERT INTO org_settings (org_id, sends_enabled) VALUES (${orgId}, true)
        ON CONFLICT (org_id) DO UPDATE SET sends_enabled = true, sends_paused = false`);
      const brand = await one<{ id: number }>(sql`
        INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${"ob-b"}, ${"OB"}) RETURNING id`);
      const contact = (await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+15650000000"}) RETURNING id`)).id;
      const provider = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send, status, send_paused,
                                   send_window_weekday_start, send_window_weekday_end)
        VALUES (${"ob-prov"}, ${orgId}, ${"OB"}, true, 'active', false, 0, 1439) RETURNING id`);
      let campSeq = 0;
      const mkCampaign = async () =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, brand_id, link_mode, status)
          VALUES (${orgId}, ${"ob-camp-" + campSeq++}, ${brand.id}, 'tracked', 'active') RETURNING id`)).id;
      let sSeq = 0;
      const mkStage = async (
        campId: number,
        opts: { scheduledAt?: string | null; materialized?: string | null } = {},
      ) =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, sms_provider_id, send_approved, scheduled_at, materialized_at)
          VALUES (${orgId}, ${campId}, ${sSeq++}, ${provider.id}, true, ${opts.scheduledAt ?? null}, ${opts.materialized ?? null})
          RETURNING id`)).id;

      // Bulk 'sent' rows (reuse one contact — the (stage_id, contact_id) unique is
      // partial on pending/sending only, so terminal 'sent' rows can repeat).
      //
      // `tag` is written into rendered_text purely as a FIXTURE HANDLE so
      // addAttributions can attach STOPs to a SPECIFIC send cohort. That is the
      // whole point of the rewrite: the breaker's numerator joins
      // opt_out_attributions.stage_send_id -> stage_sends.sent_at, so an
      // attribution has to point at a REAL send row with a controlled sent_at.
      // (The previous fixture inserted attributions with a NULL stage_send_id,
      // which the aligned join correctly counts as zero.)
      const addSent = async (
        campId: number, stageId: number, n: number, ago: string, tag: string,
      ) =>
        tx.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
          SELECT ${orgId}, ${campId}, ${stageId}, ${contact}, ${"+1565"}||g, ${tag}, 'sent', now() - ${ago}::interval
          FROM generate_series(1, ${n}) g`);

      // Attribute `n` STOPs to the sends carrying `tag`. `receiptAgo` sets
      // oa.created_at — the OLD (receipt-time) bucketing column — INDEPENDENTLY of
      // the send's sent_at, so a scenario can prove the two no longer interact.
      const addAttributions = async (
        campId: number, stageId: number, tag: string, n: number, receiptAgo: string,
      ) =>
        tx.execute(sql`
          WITH picked AS (
            SELECT id, row_number() OVER (ORDER BY id) AS rn
            FROM stage_sends
            WHERE stage_id = ${stageId} AND rendered_text = ${tag}
            ORDER BY id LIMIT ${n}
          ),
          oo AS (
            INSERT INTO opt_outs (org_id, contact_id, phone_number, source, created_at)
            SELECT ${orgId}, ${contact}, ${"+1566"}||${tag}||p.rn, 'sms_inbound', now() - ${receiptAgo}::interval
            FROM picked p
            RETURNING id, phone_number
          )
          INSERT INTO opt_out_attributions (org_id, opt_out_id, stage_send_id, stage_id, campaign_id, created_at)
          SELECT ${orgId}, oo.id, p.id, ${stageId}, ${campId}, now() - ${receiptAgo}::interval
          FROM oo JOIN picked p ON oo.phone_number = ${"+1566"}||${tag}||p.rn`);

      // Attributions with NO originating send row — the blind spot the aligned
      // numerator deliberately drops and the hourly cron watches.
      const addUnlinkedAttributions = async (
        campId: number, stageId: number, n: number, receiptAgo: string, tag: string,
      ) =>
        tx.execute(sql`
          WITH oo AS (
            INSERT INTO opt_outs (org_id, contact_id, phone_number, source, created_at)
            SELECT ${orgId}, ${contact}, ${"+1567"}||${tag}||g, 'sms_inbound', now() - ${receiptAgo}::interval
            FROM generate_series(1, ${n}) g
            RETURNING id
          )
          INSERT INTO opt_out_attributions (org_id, opt_out_id, stage_id, campaign_id, created_at)
          SELECT ${orgId}, oo.id, ${stageId}, ${campId}, now() - ${receiptAgo}::interval FROM oo`);

      const isPaused = async (campId: number) =>
        (await one<{ p: boolean }>(sql`SELECT send_paused AS p FROM campaigns WHERE id = ${campId}`)).p;
      const pauseReason = async (campId: number) =>
        (await one<{ r: string | null }>(sql`SELECT send_paused_reason AS r FROM campaigns WHERE id = ${campId}`)).r;
      const auditCount = async (campId: number) =>
        Number((await one<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM campaign_circuit_events WHERE campaign_id = ${campId} AND event='paused'`)).n);

      // ── 1. FLOOR ────────────────────────────────────────────────────────────
      console.log("1) below the min-send floor → no trip:");
      const c1 = await mkCampaign(); const s1 = await mkStage(c1);
      await addSent(c1, s1, 8, "5 hours", "t1");
      await addAttributions(c1, s1, "t1", 5, "1 hour"); // 62% but sent<10
      const r1 = await checkOptOutRateBreaker(T, { orgId, campaignId: c1, stageId: s1 });
      assert(r1.evaluated === false && r1.tripped === false, `evaluated=false tripped=false (sent ${r1.sent}<10) (got ${r1.evaluated}/${r1.tripped})`);
      assert((await isPaused(c1)) === false, "campaign NOT paused");

      // ── 2. TRIP (long window) ───────────────────────────────────────────────
      console.log("2) rate over threshold + floor cleared → trip + latch + audit:");
      const c2 = await mkCampaign(); const s2 = await mkStage(c2);
      // Sends 5h old ⇒ inside the 24h window, OUTSIDE the 2h twin.
      await addSent(c2, s2, 20, "5 hours", "t2");
      await addAttributions(c2, s2, "t2", 3, "1 hour"); // 15% > 10%, sent 20
      const r2 = await checkOptOutRateBreaker(T, { orgId, campaignId: c2, stageId: s2 });
      assert(r2.tripped === true && Math.abs(r2.rate - 0.15) < 0.001, `tripped=true rate≈0.15 (got ${r2.tripped}/${r2.rate.toFixed(3)})`);
      assert(r2.tripped_by === "24h", `tripped_by="24h" — the 2h twin saw no sends (got ${r2.tripped_by})`);
      assert((await isPaused(c2)) === true, "campaign send_paused=true");
      assert((await auditCount(c2)) === 1, "one campaign_circuit_events 'paused' row");
      const reason2 = await pauseReason(c2);
      assert(
        (reason2 ?? "").includes(`on stage ${s2}`) && (reason2 ?? "").includes("over 24h"),
        `reason names the stage + window — "${reason2}"`,
      );

      // ── 3. UNDER threshold ──────────────────────────────────────────────────
      console.log("3) rate under threshold → no trip:");
      const c3 = await mkCampaign(); const s3 = await mkStage(c3);
      await addSent(c3, s3, 20, "5 hours", "t3");
      await addAttributions(c3, s3, "t3", 1, "1 hour"); // 5% < 10%
      const r3 = await checkOptOutRateBreaker(T, { orgId, campaignId: c3, stageId: s3 });
      assert(r3.evaluated === true && r3.tripped === false, `evaluated=true tripped=false (5%) (got ${r3.evaluated}/${r3.tripped})`);

      // ── 4. THE FALSE-TRIP REGRESSION ────────────────────────────────────────
      // Campaign 465's shape: a blast 25h ago whose STOPs are STILL arriving now,
      // plus a small lane send an hour ago. The receipt-time metric divides the
      // blast's STOPs by the lane's volume; the aligned metric divides each
      // stage's STOPs by the messages that produced them.
      console.log("4) old blast's STOPs still arriving + small new send → must NOT trip:");
      const c4 = await mkCampaign();
      const s4blast = await mkStage(c4);
      const s4lane = await mkStage(c4);
      await addSent(c4, s4blast, 500, "25 hours", "t4blast");   // out of the 24h window
      await addAttributions(c4, s4blast, "t4blast", 60, "1 hour"); // STOPs received 1h ago
      await addSent(c4, s4lane, 30, "1 hour", "t4lane");        // the small new send
      const receiptCount = Number((await one<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM opt_out_attributions
        WHERE campaign_id = ${c4} AND created_at > now() - interval '24 hours'`)).n);
      assert(receiptCount === 60, `fixture is faithful: ${receiptCount} STOPs sit inside the receipt-time window`);
      const r4 = await checkOptOutRateBreaker(T, { orgId, campaignId: c4, stageId: s4lane });
      assert(r4.sent === 30, `denominator = the lane's own 30 sends (got ${r4.sent})`);
      assert(r4.opt_outs === 0, `numerator = 0 — the blast's STOPs belong to the blast's sends (got ${r4.opt_outs})`);
      assert(r4.tripped === false && r4.tripped_by === null, `no trip (receipt-time math would have been ${receiptCount}/30)`);
      assert((await isPaused(c4)) === false, "campaign NOT paused");
      // The blast stage itself: its own sends are outside the 24h window, so its
      // cohort is empty and unjudgeable — never divided into someone else's volume.
      const r4b = await checkOptOutRateBreaker(T, { orgId, campaignId: c4, stageId: s4blast });
      assert(r4b.sent === 0 && r4b.evaluated === false, `the expired blast is unjudgeable, not explosive (sent ${r4b.sent})`);

      // ── 5. SHORT-WINDOW TWIN ────────────────────────────────────────────────
      console.log("5) a fresh toxic send trips the 2h twin while 24h stays quiet:");
      const c5 = await mkCampaign(); const s5 = await mkStage(c5);
      await addSent(c5, s5, 300, "5 hours", "t5old");  // clean older volume
      await addSent(c5, s5, 20, "30 minutes", "t5new"); // fresh, toxic
      await addAttributions(c5, s5, "t5new", 5, "10 minutes"); // 25% of the fresh send
      const r5 = await checkOptOutRateBreaker(T, { orgId, campaignId: c5, stageId: s5 });
      assert(r5.tripped_by === "2h", `tripped_by="2h" (got ${r5.tripped_by})`);
      assert(r5.sent === 20 && r5.opt_outs === 5, `reports the SHORT cohort (${r5.opt_outs}/${r5.sent})`);
      assert(5 / 320 < 0.1, "…and the 24h rate (5/320 = 1.6%) was genuinely below its threshold");
      const reason5 = await pauseReason(c5);
      assert((reason5 ?? "").includes("over 2h"), `reason names the 2h window — "${reason5}"`);

      // ── 6. NULL stage_send_id EXCLUDED ──────────────────────────────────────
      console.log("6) attributions with a NULL stage_send_id are excluded from the numerator:");
      const c6 = await mkCampaign(); const s6 = await mkStage(c6);
      await addSent(c6, s6, 20, "5 hours", "t6");
      await addUnlinkedAttributions(c6, s6, 10, "1 hour", "t6"); // 50% if counted
      const r6 = await checkOptOutRateBreaker(T, { orgId, campaignId: c6, stageId: s6 });
      assert(r6.opt_outs === 0 && r6.tripped === false, `numerator=0, no trip (got ${r6.opt_outs}/${r6.tripped})`);

      // ── 7. PER-STAGE ISOLATION ──────────────────────────────────────────────
      console.log("7) a hot stage trips even though a sibling's volume would dilute it:");
      const c7 = await mkCampaign();
      const s7hot = await mkStage(c7);
      const s7cool = await mkStage(c7);
      await addSent(c7, s7hot, 20, "5 hours", "t7hot");
      await addAttributions(c7, s7hot, "t7hot", 5, "1 hour"); // 25% on the hot stage
      await addSent(c7, s7cool, 1000, "5 hours", "t7cool");   // clean sibling volume
      assert(5 / 1020 < 0.1, "campaign-level the rate would be 0.5% — safe, and wrong");
      const r7 = await checkOptOutRateBreaker(T, { orgId, campaignId: c7, stageId: s7hot });
      assert(r7.sent === 20 && r7.tripped === true, `judged on the hot stage alone (${r7.opt_outs}/${r7.sent}) → tripped`);
      assert((await pauseReason(c7) ?? "").includes(`on stage ${s7hot}`), "reason names the HOT stage");
      // The clean sibling is judged on its own numbers and does not trip.
      const r7c = await checkOptOutRateBreaker(T, { orgId, campaignId: c7, stageId: s7cool });
      assert(r7c.sent === 1000 && r7c.opt_outs === 0 && r7c.tripped_by === null, "the clean sibling reads clean");

      // ── 8. UNJOINABLE DETECTOR ──────────────────────────────────────────────
      // Counts are org-wide over real data, so assert the DELTA, not absolutes.
      console.log("8) findUnjoinableOptOutAttributions counts null-stage_send_id rows:");
      const before = await findUnjoinableOptOutAttributions(T, { windowHours: 24 });
      const c8 = await mkCampaign(); const s8 = await mkStage(c8);
      await addUnlinkedAttributions(c8, s8, 7, "2 hours", "t8");
      const after = await findUnjoinableOptOutAttributions(T, { windowHours: 24 });
      assert(after.nulls - before.nulls === 7, `nulls +7 (got +${after.nulls - before.nulls})`);
      assert(after.total - before.total === 7, `total +7 (got +${after.total - before.total})`);
      assert(
        after.total === 0 || Math.abs(after.pct - after.nulls / after.total) < 1e-9,
        "pct is nulls/total",
      );

      // ── 9. ANDed GATE ───────────────────────────────────────────────────────
      console.log("9) campaign pause excludes only that campaign; provider untouched:");
      const now = new Date("2026-07-25T18:00:00Z");
      const due = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
      const cA = await mkCampaign(); const sA = await mkStage(cA, { scheduledAt: due });
      const cB = await mkCampaign(); const sB = await mkStage(cB, { scheduledAt: due });
      await latchCampaignPause(T, { campaignId: cA, orgId, reason: "test" });
      const dueRows = await selectDueScheduledStages(T, { now, orgId, maxStages: 100 });
      const ids = dueRows.map((r) => r.stage_id);
      assert(!ids.includes(sA) && ids.includes(sB), `paused campaign A's stage excluded, sibling B included (got A:${ids.includes(sA)} B:${ids.includes(sB)})`);
      const provPaused = (await one<{ p: boolean }>(sql`SELECT send_paused AS p FROM sms_providers WHERE id=${provider.id}`)).p;
      assert(provPaused === false, "provider latch untouched by a campaign pause");

      // ── 10. STALL exclusion ─────────────────────────────────────────────────
      console.log("10) stall-detector excludes a campaign-paused stage:");
      const cS = await mkCampaign();
      const sS = await mkStage(cS, { scheduledAt: due, materialized: new Date(now.getTime() - 45 * 60 * 1000).toISOString() });
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
        VALUES (${orgId}, ${cS}, ${sS}, ${contact}, ${"+15650000001"}, ${"x"}, 'pending')`);
      const stalledBefore = (await findStalledStages(T, { now, thresholdMinutes: 30, orgId })).map((s) => s.stage_id);
      assert(stalledBefore.includes(sS), "stalled stage detected before pause");
      await latchCampaignPause(T, { campaignId: cS, orgId, reason: "test" });
      const stalledAfter = (await findStalledStages(T, { now, thresholdMinutes: 30, orgId })).map((s) => s.stage_id);
      assert(!stalledAfter.includes(sS), "campaign-paused stage excluded from stall detection");

      // ── 11. RESUME + idempotency ────────────────────────────────────────────
      console.log("11) latch is one-shot; resume re-arms:");
      const c11 = await mkCampaign();
      const first = await latchCampaignPause(T, { campaignId: c11, orgId, reason: "a" });
      const second = await latchCampaignPause(T, { campaignId: c11, orgId, reason: "b" });
      assert(first === true && second === false, `latch one-shot (first=true second=false) (got ${first}/${second})`);
      assert((await auditCount(c11)) === 1, "idempotent: only one audit row");
      await tx.execute(sql`UPDATE campaigns SET send_paused=false WHERE id=${c11}`); // manual resume
      assert((await isCampaignPaused(T, c11)) === false, "resumed → isCampaignPaused false");
      const retrip = await latchCampaignPause(T, { campaignId: c11, orgId, reason: "c" });
      assert(retrip === true, "can re-trip after resume");

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  } finally {
    await pg.end({ timeout: 5 });
  }
  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${fail} failed (rolled back)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
