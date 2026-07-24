import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

// Small, deterministic thresholds (the breaker reads process.env per call, so
// this also exercises the env-tunability): 10-send floor, 10% trip, 24h window.
process.env.OPTOUT_RATE_MIN_SENDS = "10";
process.env.OPTOUT_RATE_SPIKE_THRESHOLD = "0.10";
process.env.OPTOUT_RATE_WINDOW_SEC = "86400";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { db as dbType } from "@/db/client";
import { isCampaignPaused, latchCampaignPause } from "@/lib/sends/circuit-breakers";
import { checkOptOutRateBreaker } from "@/lib/sends/optout-rate-breaker";
import { selectDueScheduledStages } from "@/lib/sends/scheduled";
import { findStalledStages } from "@/lib/sends/stall-detector";

// Verifies P7/P8 — the per-campaign opt-out-rate breaker (migration 0119):
//   1. FLOOR: no trip below the min-send floor (a 1-of-8 blip can't trip).
//   2. TRIP: rate over threshold + floor cleared → latch + audit row.
//   3. UNDER threshold → no trip.
//   4. WINDOW: opt-outs outside the trailing window don't count.
//   5. ANDed GATE: a campaign pause excludes only THAT campaign from the
//      scheduler; a sibling on the same provider still selects, and the
//      provider latch is untouched.
//   6. STALL-detector excludes a campaign-paused stage.
//   7. RESUME + idempotency: latch is one-shot; clearing send_paused re-arms.
// Rolled-back tx, no real provider. Requires migration 0119.
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
      const addSent = async (campId: number, stageId: number, n: number, ago: string) =>
        tx.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
          SELECT ${orgId}, ${campId}, ${stageId}, ${contact}, ${"+1565"}||g, ${"x"}, 'sent', now() - ${ago}::interval
          FROM generate_series(1, ${n}) g`);
      // Bulk attributions (each needs a distinct opt_out — unique (opt_out_id, stage_id)).
      const addAttributions = async (campId: number, stageId: number, n: number, ago: string) =>
        tx.execute(sql`
          WITH oo AS (
            INSERT INTO opt_outs (org_id, contact_id, phone_number, source, created_at)
            SELECT ${orgId}, ${contact}, ${"+1566"}||g, 'sms_inbound', now() - ${ago}::interval
            FROM generate_series(1, ${n}) g
            RETURNING id
          )
          INSERT INTO opt_out_attributions (org_id, opt_out_id, stage_id, campaign_id, created_at)
          SELECT ${orgId}, oo.id, ${stageId}, ${campId}, now() - ${ago}::interval FROM oo`);
      const isPaused = async (campId: number) =>
        (await one<{ p: boolean }>(sql`SELECT send_paused AS p FROM campaigns WHERE id = ${campId}`)).p;
      const auditCount = async (campId: number) =>
        Number((await one<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM campaign_circuit_events WHERE campaign_id = ${campId} AND event='paused'`)).n);

      // ── 1. FLOOR ────────────────────────────────────────────────────────────
      console.log("1) below the min-send floor → no trip:");
      const c1 = await mkCampaign(); const s1 = await mkStage(c1);
      await addSent(c1, s1, 8, "1 hour"); await addAttributions(c1, s1, 5, "1 hour"); // 62% but sent<10
      const r1 = await checkOptOutRateBreaker(T, { orgId, campaignId: c1 });
      assert(r1.evaluated === false && r1.tripped === false, `evaluated=false tripped=false (sent ${r1.sent}<10) (got ${r1.evaluated}/${r1.tripped})`);
      assert((await isPaused(c1)) === false, "campaign NOT paused");

      // ── 2. TRIP ─────────────────────────────────────────────────────────────
      console.log("2) rate over threshold + floor cleared → trip + latch + audit:");
      const c2 = await mkCampaign(); const s2 = await mkStage(c2);
      await addSent(c2, s2, 20, "1 hour"); await addAttributions(c2, s2, 3, "1 hour"); // 15% > 10%, sent 20
      const r2 = await checkOptOutRateBreaker(T, { orgId, campaignId: c2 });
      assert(r2.tripped === true && Math.abs(r2.rate - 0.15) < 0.001, `tripped=true rate≈0.15 (got ${r2.tripped}/${r2.rate.toFixed(3)})`);
      assert((await isPaused(c2)) === true, "campaign send_paused=true");
      assert((await auditCount(c2)) === 1, "one campaign_circuit_events 'paused' row");

      // ── 3. UNDER threshold ──────────────────────────────────────────────────
      console.log("3) rate under threshold → no trip:");
      const c3 = await mkCampaign(); const s3 = await mkStage(c3);
      await addSent(c3, s3, 20, "1 hour"); await addAttributions(c3, s3, 1, "1 hour"); // 5% < 10%
      const r3 = await checkOptOutRateBreaker(T, { orgId, campaignId: c3 });
      assert(r3.evaluated === true && r3.tripped === false, `evaluated=true tripped=false (5%) (got ${r3.evaluated}/${r3.tripped})`);

      // ── 4. WINDOW ───────────────────────────────────────────────────────────
      console.log("4) opt-outs older than the window don't count:");
      const c4 = await mkCampaign(); const s4 = await mkStage(c4);
      await addSent(c4, s4, 20, "1 hour"); await addAttributions(c4, s4, 5, "25 hours"); // STOPs >24h ago
      const r4 = await checkOptOutRateBreaker(T, { orgId, campaignId: c4 });
      assert(r4.opt_outs === 0 && r4.tripped === false, `numerator=0 (windowed out) tripped=false (got ${r4.opt_outs}/${r4.tripped})`);

      // ── 5. ANDed GATE ───────────────────────────────────────────────────────
      console.log("5) campaign pause excludes only that campaign; provider untouched:");
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

      // ── 6. STALL exclusion ──────────────────────────────────────────────────
      console.log("6) stall-detector excludes a campaign-paused stage:");
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

      // ── 7. RESUME + idempotency ─────────────────────────────────────────────
      console.log("7) latch is one-shot; resume re-arms:");
      const c7 = await mkCampaign();
      const first = await latchCampaignPause(T, { campaignId: c7, orgId, reason: "a" });
      const second = await latchCampaignPause(T, { campaignId: c7, orgId, reason: "b" });
      assert(first === true && second === false, `latch one-shot (first=true second=false) (got ${first}/${second})`);
      assert((await auditCount(c7)) === 1, "idempotent: only one audit row");
      await tx.execute(sql`UPDATE campaigns SET send_paused=false WHERE id=${c7}`); // manual resume
      assert((await isCampaignPaused(T, c7)) === false, "resumed → isCampaignPaused false");
      const retrip = await latchCampaignPause(T, { campaignId: c7, orgId, reason: "c" });
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
