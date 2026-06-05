// Reschedule-lock + missed-reschedulable verification for scheduled sends.
//
// Two safety invariants, both load-bearing:
//   1. The edit lock applies ONLY to FIRED stages (sent_at set), never to MISSED
//      ones (sent_at NULL). A wrongly-locked missed stage could never clear its
//      schedule_missed_at marker (the cron filters schedule_missed_at IS NULL)
//      and would be STRANDED forever.
//   2. Rescheduling a missed stage clears the marker, keeps sent_at NULL, and
//      RE-ENTERS cron selection (re-armed).
//
// Part A exercises the pure decision the PATCH route actually calls
// (decideScheduleEdit). Part B is fixture-backed inside a rolled-back
// transaction: it reschedules a real missed stage and proves the REAL
// selectDueScheduledStages picks it up afterward (and didn't before). No data
// persists; nothing is sent.
//
// Run: npx tsx scripts/test-scheduled-reschedule.ts
import "./_env-preload"; // MUST be first — loads .env.local before db/client init
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { decideScheduleEdit } from "@/lib/sends/schedule-edit";
import { selectDueScheduledStages } from "@/lib/sends/scheduled";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

const T0 = "2026-06-15T16:00:00Z"; // original scheduled time
const T1 = "2026-06-15T16:02:00Z"; // rescheduled time (still <= NOW, in window)
const NOW = new Date("2026-06-15T16:05:00Z");
const FIRED_AT = "2026-06-15T16:00:30Z";
const MISSED_AT = "2026-06-15T16:01:00Z";

const ROLLBACK = Symbol("rollback");

function partA() {
  // 1. MISSED tracked stage, new time → NOT locked, clears the marker.
  const missed = decideScheduleEdit(
    { linkMode: "tracked", sentAt: null, scheduleMissedAt: MISSED_AT, currentScheduledAt: T0 },
    T1,
  );
  check(
    "missed+changed → not locked, clears marker",
    missed.locked === false && missed.clearMissed === true && missed.scheduledChanged === true,
    JSON.stringify(missed),
  );

  // 2. FIRED tracked stage, new time → LOCKED.
  const firedChange = decideScheduleEdit(
    { linkMode: "tracked", sentAt: FIRED_AT, scheduleMissedAt: null, currentScheduledAt: T0 },
    T1,
  );
  check("fired+changed → locked", firedChange.locked === true, JSON.stringify(firedChange));

  // 3. FIRED tracked stage, SAME time → not a change, not locked.
  const firedSame = decideScheduleEdit(
    { linkMode: "tracked", sentAt: FIRED_AT, scheduleMissedAt: null, currentScheduledAt: T0 },
    T0,
  );
  check(
    "fired+unchanged → not locked",
    firedSame.locked === false && firedSame.scheduledChanged === false,
    JSON.stringify(firedSame),
  );

  // 4. FIRED tracked stage, scheduled_at ABSENT from payload → not a change.
  const firedAbsent = decideScheduleEdit(
    { linkMode: "tracked", sentAt: FIRED_AT, scheduleMissedAt: null, currentScheduledAt: T0 },
    undefined,
  );
  check(
    "fired + field absent → not locked",
    firedAbsent.locked === false && firedAbsent.scheduledChanged === false,
  );

  // 5. MANUAL campaign, fired, new time → NEVER locked (lock is tracked-only).
  const manual = decideScheduleEdit(
    { linkMode: "manual", sentAt: FIRED_AT, scheduleMissedAt: null, currentScheduledAt: T0 },
    T1,
  );
  check("manual fired+changed → not locked", manual.locked === false, JSON.stringify(manual));

  // 6. MISSED stage, SAME time (no-op PATCH) → don't clear the marker.
  const missedNoop = decideScheduleEdit(
    { linkMode: "tracked", sentAt: null, scheduleMissedAt: MISSED_AT, currentScheduledAt: T0 },
    T0,
  );
  check(
    "missed + unchanged → marker NOT cleared",
    missedNoop.clearMissed === false && missedNoop.scheduledChanged === false,
    JSON.stringify(missedNoop),
  );
}

async function partB() {
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const orgRows = (await tx.execute(
        sql`SELECT id FROM organizations LIMIT 1`,
      )) as unknown as { id: string }[];
      const orgId = orgRows[0]?.id;
      if (!orgId) throw new Error("no organization in DB to anchor fixtures");

      const prov = (await tx.execute(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"resched-" + sfx}, ${orgId}, ${"resched-test"}, true)
        RETURNING id
      `)) as unknown as { id: number }[];
      const providerId = prov[0].id;

      const cre = (await tx.execute(sql`
        INSERT INTO creatives (slug, org_id, text, status)
        VALUES (${"resched-cre-" + sfx}, ${orgId}, ${"Reschedule test"}, 'active')
        RETURNING id
      `)) as unknown as { id: number }[];
      const creativeId = cre[0].id;

      const camp = (await tx.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode)
        VALUES (${orgId}, ${"resched-camp-" + sfx}, ${"resched-test"}, 'active', 'tracked')
        RETURNING id
      `)) as unknown as { id: number }[];
      const campaignId = camp[0].id;

      // FIRED stage: sent_at set (locked). MISSED stage: sent_at NULL +
      // schedule_missed_at set (reschedulable). Both approved, scheduled in past.
      const fired = (await tx.execute(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, creative_id, sms_provider_id,
           send_approved, scheduled_at, sent_at)
        VALUES (${orgId}, ${campaignId}, 1, ${creativeId}, ${providerId},
           true, ${T0}, ${FIRED_AT})
        RETURNING id
      `)) as unknown as { id: number }[];
      const firedStageId = fired[0].id;

      const missed = (await tx.execute(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, creative_id, sms_provider_id,
           send_approved, scheduled_at, schedule_missed_at)
        VALUES (${orgId}, ${campaignId}, 2, ${creativeId}, ${providerId},
           true, ${T0}, ${MISSED_AT})
        RETURNING id
      `)) as unknown as { id: number }[];
      const missedStageId = missed[0].id;

      // ── Before reschedule: neither stage is cron-selectable ──────────────
      const dueBefore = await selectDueScheduledStages(tx as unknown as typeof db, {
        now: NOW,
        orgId,
        maxStages: 200,
      });
      const idsBefore = new Set(dueBefore.map((r) => r.stage_id));
      check("missed stage NOT selected before reschedule", !idsBefore.has(missedStageId));
      check("fired stage NOT selected (sent_at set)", !idsBefore.has(firedStageId));

      // ── The reschedule: decide as the route does, then apply ─────────────
      // Read current state back from the DB (faithful to the route's load).
      const cur = (await tx.execute(sql`
        SELECT cs.sent_at, cs.schedule_missed_at, cs.scheduled_at, c.link_mode
        FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
        WHERE cs.id = ${missedStageId}
      `)) as unknown as {
        sent_at: string | null;
        schedule_missed_at: string | null;
        scheduled_at: string | null;
        link_mode: string;
      }[];
      const decision = decideScheduleEdit(
        {
          linkMode: cur[0].link_mode,
          sentAt: cur[0].sent_at,
          scheduleMissedAt: cur[0].schedule_missed_at,
          currentScheduledAt: cur[0].scheduled_at,
        },
        T1,
      );
      check("rescheduling missed is NOT locked", decision.locked === false);
      check("rescheduling missed clears the marker", decision.clearMissed === true);

      // Apply exactly what the route would: new scheduled_at + clear marker
      // (only because decision.clearMissed). sent_at untouched.
      await tx.execute(sql`
        UPDATE campaign_stages
        SET scheduled_at = ${T1},
            schedule_missed_at = ${decision.clearMissed ? null : sql`schedule_missed_at`}
        WHERE id = ${missedStageId}
      `);

      // ── After reschedule: missed stage is re-armed (cron-selectable) ─────
      const after = (await tx.execute(sql`
        SELECT sent_at, schedule_missed_at FROM campaign_stages WHERE id = ${missedStageId}
      `)) as unknown as { sent_at: string | null; schedule_missed_at: string | null }[];
      check("after reschedule: sent_at still NULL", after[0].sent_at == null);
      check("after reschedule: schedule_missed_at cleared", after[0].schedule_missed_at == null);

      const dueAfter = await selectDueScheduledStages(tx as unknown as typeof db, {
        now: NOW,
        orgId,
        maxStages: 200,
      });
      const idsAfter = new Set(dueAfter.map((r) => r.stage_id));
      check("missed stage IS re-selected after reschedule (re-armed)", idsAfter.has(missedStageId));
      check("fired stage STILL not selected", !idsAfter.has(firedStageId));

      throw ROLLBACK; // never persist fixtures
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

async function main() {
  console.log("Part A — pure lock decision (the helper the PATCH route uses):");
  partA();
  console.log("\nPart B — fixture-backed re-selection (rolled back):");
  await partB();

  await pgConn.end({ timeout: 5 });
  console.log(
    failed === 0
      ? "\nReschedule-lock + missed-reschedulable verified (no data persisted)."
      : `\nFAILED: ${failed} check(s).`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Reschedule test crashed:", err);
  process.exit(1);
});
