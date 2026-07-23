// WS2 scheduler decoupling: a stage PRE-MATERIALIZED for a FUTURE schedule (the
// new Approve-Send flow) must NOT be drained by the cron until its time arrives
// AND the send window is open. Once due+in-window it fires (stamping sent_at),
// and a released stage whose window has since closed HOLDS its leftovers.
//
// Injected fake drain (no TextHub), single rolled-back tx (nothing persists).
// Run: npx tsx scripts/test-scheduled-decouple.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import type { DrainResult } from "@/lib/sends/drain";
import { runScheduledSends } from "@/lib/sends/scheduled";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

// Weekday ET noon = in default 08:00–21:00 window. "Future" is 3 days ahead.
const NOON_ET = new Date("2026-06-15T16:00:00Z"); // 12:00 ET (EDT)
const FUTURE = "2026-06-18T16:00:00Z"; // +3 days, same noon-ET
const EVENING_ET = new Date("2026-06-15T03:30:00Z"); // 23:30 ET prev day → outside window

const ROLLBACK = Symbol("rollback");

async function main() {
  const drainCalls: number[] = [];
  const fakeDrain = async (stageId: number): Promise<DrainResult> => {
    drainCalls.push(stageId);
    return { ok: true, sent: 4, failed: 0, filtered: 0, skippedDuplicate: 0, skippedOptedOut: 0, processed: 4, halted: false, stuck: 0, remaining: 0, stopReason: null, pausedNow: false };
  };

  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const org = (await tx.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as { id: string }[];
      const orgId = org[0]?.id;
      if (!orgId) throw new Error("no organization");

      const prov = (await tx.execute(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"dec-" + sfx}, ${orgId}, ${"decouple-test"}, true) RETURNING id
      `)) as unknown as { id: number }[];
      const providerId = prov[0].id;
      const cre = (await tx.execute(sql`
        INSERT INTO creatives (slug, org_id, text, status)
        VALUES (${"dec-cre-" + sfx}, ${orgId}, ${"x"}, 'active') RETURNING id
      `)) as unknown as { id: number }[];
      const camp = (await tx.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode)
        VALUES (${orgId}, ${"dec-camp-" + sfx}, ${"d"}, 'active', 'tracked') RETURNING id
      `)) as unknown as { id: number }[];
      const campaignId = camp[0].id;

      // A stage ARMED for the future: approved, scheduled_at in 3 days, already
      // materialized (pending rows), NOT yet released (sent_at NULL).
      const st = (await tx.execute(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, creative_id, sms_provider_id, send_approved, scheduled_at)
        VALUES (${orgId}, ${campaignId}, 1, ${cre[0].id}, ${providerId}, true, ${FUTURE})
        RETURNING id
      `)) as unknown as { id: number }[];
      const stageId = st[0].id;
      const contact = (await tx.execute(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1555" + sfx}) RETURNING id
      `)) as unknown as { id: string }[];
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
        VALUES (${orgId}, ${campaignId}, ${stageId}, ${contact[0].id}, ${"+15550000"}, ${"hi"}, 'pending')
      `);

      // TICK 1 — now is BEFORE the scheduled time. Armed stage must be held.
      const t1 = await runScheduledSends(tx as unknown as typeof db, {
        now: NOON_ET, orgId, isEnabled: () => true, isOrgEnabled: async () => true, runDrain: fakeDrain, maxStages: 50,
      });
      check("future-armed: not drained before its time", t1.drained === 0, JSON.stringify(t1));
      check("future-armed: not even a candidate (drain_held 0)", t1.drain_held === 0, `got ${t1.drain_held}`);
      const a1 = (await tx.execute(sql`SELECT sent_at FROM campaign_stages WHERE id = ${stageId}`)) as unknown as { sent_at: string | null }[];
      check("future-armed: sent_at still NULL", a1[0].sent_at === null);
      check("future-armed: drain never called", !drainCalls.includes(stageId));

      // TICK 2 — now is the scheduled time, in window. Must fire + release.
      const DUE = new Date(FUTURE); // exactly due, noon ET → in window
      const t2 = await runScheduledSends(tx as unknown as typeof db, {
        now: DUE, orgId, isEnabled: () => true, isOrgEnabled: async () => true, runDrain: fakeDrain, maxStages: 50,
      });
      check("due+in-window: drained 1", t2.drained === 1, JSON.stringify(t2));
      const a2 = (await tx.execute(sql`SELECT sent_at FROM campaign_stages WHERE id = ${stageId}`)) as unknown as { sent_at: string | null }[];
      check("due+in-window: sent_at stamped (released)", a2[0].sent_at !== null);
      check("due+in-window: drain called once for the stage", drainCalls.filter((s) => s === stageId).length === 1);

      // TICK 3 — the stage is now RELEASED (sent_at set from tick 2) and still has
      // a pending row (the injected fake drain doesn't mutate the DB). With now
      // OUTSIDE the window, its leftovers must be HELD, not drained.
      const before = drainCalls.length;
      const t3 = await runScheduledSends(tx as unknown as typeof db, {
        now: EVENING_ET, orgId, isEnabled: () => true, isOrgEnabled: async () => true, runDrain: fakeDrain, maxStages: 50,
      });
      check("released + outside window: held (not drained)", t3.drained === 0 && drainCalls.length === before, JSON.stringify(t3));

      throw ROLLBACK;
    });
  } catch (e) { if (e !== ROLLBACK) throw e; }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nScheduler decoupling verified (rolled back)." : `\nFAILED: ${failed}`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
