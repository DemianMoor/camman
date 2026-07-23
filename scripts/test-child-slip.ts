import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { formatInTimeZone } from "date-fns-tz";

import type { db as dbType } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { isOutsideSendWindow, type ProviderSendWindow } from "@/lib/quiet-hours";
import { decideChildSlip } from "@/lib/sends/child-slip";
import type { Sender } from "@/lib/sends/drain";
import { enumerateStageRecipients } from "@/lib/sends/recipients";
import { getParentState, runScheduledSends } from "@/lib/sends/scheduled";

// Verifies P4 — the parent-complete gate + bounded slip for lane children
// (migration 0117). Three layers:
//   A. Pure decideChildSlip decisions (fire / wait+engage / slip / cross-day
//      quiet-hours placement / 24h hold, both cap paths / already-placed fire).
//   B. getParentState completeness — mixed sent+failed = COMPLETE (a failed
//      number never blocks the gate); pending/sending = incomplete.
//   C. Child audience excludes a FAILED parent contact via the sent-row lane
//      aliveness filter.
//   D. End-to-end: provider paused mid-drain → parent stranded incomplete →
//      due child HOLDS at the 24h cap (parent_incomplete_24h) — the fail-safe.
// B/C/D run in a rolled-back tx (no real provider). Requires migration 0117.
//
// Run: npx tsx scripts/test-child-slip.ts

class Rollback extends Error {}
let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${msg}`);
  if (cond) pass++;
  else fail++;
}

const D = (iso: string) => new Date(iso);
// Default provider window (nulls ⇒ 8:00–21:00 ET). Times below are summer (EDT,
// UTC−4): 08:00 ET = 12:00Z · 12:00 ET = 16:00Z · 21:00 ET = 01:00Z(+1).
const W: ProviderSendWindow = {
  send_window_weekday_start: null,
  send_window_weekday_end: null,
  send_window_weekend_start: null,
  send_window_weekend_end: null,
};
const etStr = (d: Date) => formatInTimeZone(d, CAMPAIGN_TIMEZONE, "yyyy-MM-dd HH:mm");

const okSender: Sender = async () => ({
  ok: true, messageId: "TH", response: "queued", providerStatus: null,
  suppressed: false, rawBody: "{}", error: null, status: 200, timedOut: false,
});

function partA() {
  console.log("A) pure decideChildSlip:");

  // A1 — regime b: parent complete before the child ever waited → FIRE at original.
  const a1 = decideChildSlip({
    now: D("2026-07-16T16:00:00Z"), childScheduledAt: D("2026-07-16T16:00:00Z"),
    slipOriginalScheduledAt: null, slipCount: 0,
    parentScheduledAt: D("2026-07-15T14:00:00Z"), parentComplete: true, window: W,
  });
  assert(a1.kind === "fire", `regime-b (parent complete, never waited) → fire (got ${a1.kind})`);

  // A2 — parent incomplete, first encounter → WAIT + engage.
  const a2 = decideChildSlip({
    now: D("2026-07-16T16:00:00Z"), childScheduledAt: D("2026-07-16T16:00:00Z"),
    slipOriginalScheduledAt: null, slipCount: 0,
    parentScheduledAt: D("2026-07-15T14:00:00Z"), parentComplete: false, window: W,
  });
  assert(a2.kind === "wait" && a2.engage === true, `parent incomplete, first tick → wait+engage (got ${a2.kind}/${a2.kind === "wait" && a2.engage})`);

  // A3 — parent incomplete, already engaged, within cap → WAIT (no re-engage).
  const a3 = decideChildSlip({
    now: D("2026-07-16T17:00:00Z"), childScheduledAt: D("2026-07-16T16:00:00Z"),
    slipOriginalScheduledAt: D("2026-07-16T16:00:00Z"), slipCount: 0,
    parentScheduledAt: D("2026-07-15T14:00:00Z"), parentComplete: false, window: W,
  });
  assert(a3.kind === "wait" && a3.engage === false, `incomplete+engaged within cap → wait (got ${a3.kind})`);

  // A4 — parent incomplete 24h+ past original → HOLD(parent_incomplete_24h).
  const a4 = decideChildSlip({
    now: D("2026-07-16T17:00:00Z"), childScheduledAt: D("2026-07-15T16:00:00Z"),
    slipOriginalScheduledAt: D("2026-07-15T16:00:00Z"), slipCount: 0,
    parentScheduledAt: D("2026-07-15T14:00:00Z"), parentComplete: false, window: W,
  });
  assert(a4.kind === "hold" && a4.reason === "parent_incomplete_24h", `incomplete 25h → hold(parent_incomplete_24h) (got ${a4.kind}/${a4.kind === "hold" && a4.reason})`);

  // A5 — regime a: waited, parent finished late → SLIP to now+offset, in window.
  const a5 = decideChildSlip({
    now: D("2026-07-15T18:00:00Z"), childScheduledAt: D("2026-07-15T16:00:00Z"),
    slipOriginalScheduledAt: D("2026-07-15T16:00:00Z"), slipCount: 0,
    parentScheduledAt: D("2026-07-15T14:00:00Z"), parentComplete: true, window: W,
  });
  const a5ok = a5.kind === "slip" && a5.newScheduledAt.toISOString() === "2026-07-15T20:00:00.000Z" && !isOutsideSendWindow(W, a5.newScheduledAt);
  assert(a5ok, `regime-a slip → now+offset=20:00Z, in window (got ${a5.kind}${a5.kind === "slip" ? " " + a5.newScheduledAt.toISOString() : ""})`);

  // A6 — slip placement overshoots 24h cap → HOLD(slip_cap_exceeded).
  const a6 = decideChildSlip({
    now: D("2026-07-16T20:00:00Z"), childScheduledAt: D("2026-07-15T16:00:00Z"),
    slipOriginalScheduledAt: D("2026-07-15T16:00:00Z"), slipCount: 0,
    parentScheduledAt: D("2026-07-15T14:00:00Z"), parentComplete: true, window: W,
  });
  assert(a6.kind === "hold" && a6.reason === "slip_cap_exceeded", `placement > original+24h → hold(slip_cap_exceeded) (got ${a6.kind}/${a6.kind === "hold" && a6.reason})`);

  // A7 — candidate lands in quiet hours (22:00 ET) → placed = NEXT ET day 08:00.
  const a7 = decideChildSlip({
    now: D("2026-07-16T02:00:00Z"), childScheduledAt: D("2026-07-15T16:00:00Z"),
    slipOriginalScheduledAt: D("2026-07-15T16:00:00Z"), slipCount: 0,
    parentScheduledAt: D("2026-07-15T16:00:00Z"), parentComplete: true, window: W,
  });
  const a7ok = a7.kind === "slip" && etStr(a7.newScheduledAt) === "2026-07-16 08:00";
  assert(a7ok, `cross-day: candidate 22:00 ET → placed next day 08:00 ET (got ${a7.kind}${a7.kind === "slip" ? " " + etStr(a7.newScheduledAt) + " ET" : ""})`);

  // A8 — already placed (slipCount>0), due again, parent complete → FIRE.
  const a8 = decideChildSlip({
    now: D("2026-07-16T16:00:00Z"), childScheduledAt: D("2026-07-16T16:00:00Z"),
    slipOriginalScheduledAt: D("2026-07-15T16:00:00Z"), slipCount: 1,
    parentScheduledAt: D("2026-07-15T14:00:00Z"), parentComplete: true, window: W,
  });
  assert(a8.kind === "fire", `already placed + parent complete → fire (got ${a8.kind})`);
}

async function main() {
  partA();

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
        ON CONFLICT (org_id) DO UPDATE SET sends_enabled = true`);
      const brand = await one<{ id: number }>(sql`
        INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${"cs-b"}, ${"CS"}) RETURNING id`);
      let cSeq = 0;
      const mkContact = async () =>
        (await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number)
          VALUES (${orgId}, ${`+1562000${String(cSeq++).padStart(4, "0")}`}) RETURNING id`)).id;
      const mkProvider = async (key: string, paused: boolean) =>
        (await one<{ id: number }>(sql`
          INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send, status,
                                     send_paused, max_sends_per_24h, max_sends_per_minute, max_sends_per_run)
          VALUES (${key}, ${orgId}, ${key}, true, 'active', ${paused},
                  ${100_000_000}, ${100_000_000}, ${100_000_000}) RETURNING id`)).id;
      const mkCampaign = async (slug: string) =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, brand_id, link_mode, status)
          VALUES (${orgId}, ${slug}, ${brand.id}, 'tracked', 'active') RETURNING id`)).id;
      let sSeq = 0;
      const mkStage = async (
        campId: number, providerId: number,
        opts: { sentAt?: string | null; materialized?: boolean; scheduledAt?: string | null;
                parentId?: number | null; tier?: number | null } = {},
      ) =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, sms_provider_id, send_approved,
             sent_at, materialized_at, scheduled_at, parent_stage_id, behavioral_tier)
          VALUES (${orgId}, ${campId}, ${sSeq++}, ${providerId}, true,
                  ${opts.sentAt ?? null}, ${opts.materialized ? sql`now()` : null},
                  ${opts.scheduledAt ?? null}, ${opts.parentId ?? null}, ${opts.tier ?? null})
          RETURNING id`)).id;
      const addSend = async (campId: number, stageId: number, contactId: string, status: string) =>
        tx.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
          VALUES (${orgId}, ${campId}, ${stageId}, ${contactId}, ${"+15629999999"}, ${"x"}, ${status})`);

      // ── B) getParentState completeness ─────────────────────────────────────
      console.log("B) getParentState completeness:");
      const campB = await mkCampaign("cs-b1");
      const provB = await mkProvider("cs-pb", false);

      // B1 — sent_at set + [sent, failed] (both terminal) → COMPLETE.
      const pB1 = await mkStage(campB, provB, { sentAt: "2026-07-15T14:00:00Z", materialized: true });
      await addSend(campB, pB1, await mkContact(), "sent");
      await addSend(campB, pB1, await mkContact(), "failed");
      assert((await getParentState(T, pB1)).complete === true, "sent + failed (no pending/sending) → COMPLETE (failed doesn't block)");

      // B2 — sent_at set + [sent, pending] → incomplete.
      const pB2 = await mkStage(campB, provB, { sentAt: "2026-07-15T14:00:00Z", materialized: true });
      await addSend(campB, pB2, await mkContact(), "sent");
      await addSend(campB, pB2, await mkContact(), "pending");
      assert((await getParentState(T, pB2)).complete === false, "sent + pending → incomplete");

      // B3 — sent_at set + [sent, sending] → incomplete.
      const pB3 = await mkStage(campB, provB, { sentAt: "2026-07-15T14:00:00Z", materialized: true });
      await addSend(campB, pB3, await mkContact(), "sent");
      await addSend(campB, pB3, await mkContact(), "sending");
      assert((await getParentState(T, pB3)).complete === false, "sent + sending → incomplete");

      // B4 — never released (sent_at NULL) → incomplete even with only terminal rows.
      const pB4 = await mkStage(campB, provB, { sentAt: null, materialized: true });
      await addSend(campB, pB4, await mkContact(), "sent");
      assert((await getParentState(T, pB4)).complete === false, "sent_at NULL → incomplete");

      // ── C) child audience excludes a FAILED parent contact ─────────────────
      console.log("C) child lane audience excludes failed parent contact:");
      const campC = await mkCampaign("cs-c1");
      const provC = await mkProvider("cs-pc", false);
      const parentC = await mkStage(campC, provC, { sentAt: "2026-07-15T14:00:00Z", materialized: true });
      const cA = await mkContact(); // parent SENT → alive
      const cB = await mkContact(); // parent FAILED → not alive
      await addSend(campC, parentC, cA, "sent");
      await addSend(campC, parentC, cB, "failed");
      for (const cid of [cA, cB]) {
        await tx.execute(sql`
          INSERT INTO campaign_audience_pool
            (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot, was_opt_in_at_snapshot)
          VALUES (${orgId}, ${campC}, ${cid}, true, false, false)`);
      }
      const recips = await enumerateStageRecipients(T, {
        campaignId: campC, orgId,
        filters: {
          includeNoStatus: true, includeClickers: false, excludeClickers: false,
          splitIndex: null, splitTotal: null, behavioralTier: 0, parentStageId: parentC,
        },
      });
      const ids = recips.map((r) => r.contact_id);
      assert(ids.length === 1 && ids[0] === cA, `child (tier 0) audience = {alive A} only, failed B excluded (got ${ids.length}: ${ids.join(",")})`);

      // ── D) end-to-end: paused-parent stranded → child HOLDS at 24h cap ──────
      console.log("D) stranded parent (paused mid-drain) → child holds at 24h cap:");
      const now = D("2026-07-16T18:00:00Z");
      const campD = await mkCampaign("cs-d1");
      const provPaused = await mkProvider("cs-pd-paused", true); // parent's provider paused
      const provActive = await mkProvider("cs-pd-active", false); // child's provider active
      const parentD = await mkStage(campD, provPaused, {
        sentAt: "2026-07-15T10:00:00Z", materialized: true, scheduledAt: "2026-07-15T10:00:00Z",
      });
      await addSend(campD, parentD, await mkContact(), "sent");
      await addSend(campD, parentD, await mkContact(), "pending"); // frozen (provider paused) → parent incomplete
      const childD = await mkStage(campD, provActive, {
        scheduledAt: "2026-07-15T17:00:00Z", parentId: parentD, tier: 0, // 25h before `now`
      });
      const runRes = await runScheduledSends(T, {
        now, orgId, sendSms: okSender, isEnabled: () => true, isOrgEnabled: async () => true,
      });
      const child = await one<{ hold: string | null; reason: string | null; mat: string | null; missed: string | null }>(sql`
        SELECT slip_hold_at AS hold, slip_hold_reason AS reason,
               materialized_at AS mat, schedule_missed_at AS missed
        FROM campaign_stages WHERE id = ${childD}`);
      assert(child.hold != null && child.reason === "parent_incomplete_24h", `child HELD, reason=parent_incomplete_24h (got hold=${child.hold != null}, reason=${child.reason})`);
      assert(child.mat == null && child.missed == null, "child NOT materialized and NOT burned as missed");
      assert(runRes.slip_held >= 1, `run result slip_held >= 1 (got ${runRes.slip_held})`);

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
