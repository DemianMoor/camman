import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { createPartnerWithKey } from "./_partner-fixture";
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { runDripRoutingBatch } from "@/lib/drip/routing";

// Drip carry-over routing ("Send leads", spec 2026-10-12), against the PREVIEW DB.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-carry-over.ts
//
// Runs the REAL routing worker, scoped to a throwaway org (onlyOrgId), and
// asserts:
//   C1  carry 0: yesterday's lead is not admitted; today's is, carried_days 0
//   C2  ⭐ carry 1 widened at T: a lead before T is never evaluated; after T it
//       is admitted with carried_days 1
//   C3  ⭐ a 50-lead backlog from before the widening is never evaluated (carry 7)
//   C4  ⭐ cap 10, reserve 0: 8 fresh + 2 carried (fresh evaluated first)
//   C5  reserve 3: 8 fresh + 0 carried
//   C6  fresh leads ignore the reserve
//   C7  lowering carry to 0 stops carries on the next tick
// The org (and everything under it) is deleted at the end.

const MARKER = "__DRIP_CARRY_OVER_TEST__";
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];

  const sfx = String(Date.now()).slice(-7);
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(
      sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${sfx}`}) RETURNING id`)).id;
    await db.execute(sql`
      INSERT INTO org_settings (org_id, drip_enabled, drip_paused)
      VALUES (${orgId}::uuid, true, false)
      ON CONFLICT (org_id) DO UPDATE SET drip_enabled = true, drip_paused = false`);
    const keyId = (await createPartnerWithKey(db, {
      orgId, slug: "co-" + sfx, name: "co", token: "tokco" + sfx,
    })).keyId;

    const mkCampaign = async (tag: string, cfg: { admissionCap?: number; carry?: number | null } = {}) => {
      const id = (await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type)
        VALUES (${orgId}::uuid, ${`co-${sfx}-${tag}`}, ${`CO ${tag}`}, 'active', 'drip') RETURNING id`)).id;
      await db.execute(sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, routing_daily_admission_cap, carry_days)
        VALUES (${id}, ${orgId}::uuid, ${tag}, ${cfg.admissionCap ?? null}, ${cfg.carry ?? null})`);
      return id;
    };
    let phoneN = 0;
    const mkLead = async (tag: string, receivedAt: Date) => {
      phoneN++;
      const contactId = (await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${`+1995${sfx}${String(phoneN).padStart(4, "0")}`})
        RETURNING id`)).id;
      const id = (await one<{ id: string }>(sql`
        INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, interest_tag, received_at)
        VALUES (${orgId}::uuid, ${contactId}::uuid, ${keyId}, 'co', ${tag}, ${receivedAt.toISOString()}::timestamptz)
        RETURNING id`)).id;
      return { id, contactId };
    };
    const setWidened = (id: number, at: Date) => db.execute(sql`
      UPDATE drip_campaign_configs SET admission_widened_at = ${at.toISOString()}::timestamptz WHERE campaign_id = ${id}`);
    const tick = () => runDripRoutingBatch(new Date(), { onlyOrgId: orgId });
    const journey = (leadId: string) => one<{ state: string; carried_days: number } | undefined>(sql`
      SELECT state, carried_days FROM drip_journeys WHERE lead_event_id = ${leadId}::uuid`);
    const evaluated = (leadId: string) => one<{ n: number }>(sql`
      SELECT (drip_recheck_at IS NOT NULL OR EXISTS (SELECT 1 FROM drip_journeys j WHERE j.lead_event_id = e.id))::int AS n
      FROM lead_events e WHERE e.id = ${leadId}::uuid`);

    const now = new Date();
    const today = campaignDayBoundsUtc(now).start;
    const yStart = campaignDayBoundsUtc(new Date(today.getTime() - 1)).start;
    const T = new Date(yStart.getTime() + 15 * 3600_000);           // yesterday 15:00 ET
    const freshAt = new Date(Math.min(today.getTime() + 1000, now.getTime()));

    // C1 carry 0 — only today's lead is admitted, carried_days 0
    const c0 = await mkCampaign("c0");
    const c0Old = await mkLead("c0", new Date(yStart.getTime() + 20 * 3600_000));
    const c0New = await mkLead("c0", freshAt);
    // C2 carry 1 widened at T — before T never evaluated, after T admitted carried
    const c1 = await mkCampaign("c1", { carry: 1 });
    await setWidened(c1, T);
    const c1Pre = await mkLead("c1", new Date(T.getTime() - 3600_000));
    const c1Post = await mkLead("c1", new Date(T.getTime() + 3600_000));
    // C3 backlog: 50 leads two days ago, campaign carry 7 widened at T
    const c7 = await mkCampaign("c7", { carry: 7 });
    await setWidened(c7, T);
    const backlog = [];
    for (let i = 0; i < 50; i++) backlog.push(await mkLead("c7", new Date(yStart.getTime() - 12 * 3600_000 - i * 1000)));

    await tick();

    bar("C1 carry 0: yesterday's lead not admitted", (await journey(c0Old.id)) === undefined);
    const j0 = await journey(c0New.id);
    bar("C1 carry 0: today's lead admitted, carried_days 0", j0?.state === "routed" && j0.carried_days === 0, JSON.stringify(j0));
    bar("C2 ⭐ pre-widening lead NEVER evaluated", (await evaluated(c1Pre.id)).n === 0);
    const j1 = await journey(c1Post.id);
    bar("C2 post-widening lead admitted with carried_days 1", j1?.state === "routed" && j1.carried_days === 1, JSON.stringify(j1));
    let backlogTouched = 0;
    for (const b of backlog) backlogTouched += (await evaluated(b.id)).n;
    bar("C3 ⭐ backlog never evaluated under carry 7", backlogTouched === 0, `${backlogTouched}/50`);

    // C4 priority + reserve. cap 10; 8 fresh + 5 carried; reserve seeded as
    // same-day journeys routed yesterday 1 min before midnight.
    const seedReserve = async (campaignId: number, tag: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const l = await mkLead(tag, new Date(today.getTime() - 120_000));
        await db.execute(sql`
          INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state, routed_at, reason, carried_days)
          VALUES (${orgId}::uuid, ${campaignId}, ${l.contactId}::uuid, ${l.id}::uuid, 'routed',
                  ${new Date(today.getTime() - 60_000).toISOString()}::timestamptz, '{}'::jsonb, 0)`);
      }
    };
    const scenario = async (tag: string, reserve: number, fresh: number, carriedN: number) => {
      const id = await mkCampaign(tag, { admissionCap: 10, carry: 1 });
      await setWidened(id, T);
      await seedReserve(id, tag, reserve);
      const cs = []; for (let i = 0; i < carriedN; i++) cs.push(await mkLead(tag, new Date(T.getTime() + 60_000 + i * 1000)));
      const fs = []; for (let i = 0; i < fresh; i++) fs.push(await mkLead(tag, new Date(freshAt.getTime() - i)));
      await tick();
      const routed = async (ls: { id: string }[]) => {
        let n = 0; for (const l of ls) if ((await journey(l.id))?.state === "routed") n++; return n;
      };
      return { fresh: await routed(fs), carried: await routed(cs) };
    };
    const r0 = await scenario("r0", 0, 8, 5);
    bar("C4 ⭐ reserve 0: 8 fresh + 2 carried (fresh first)", r0.fresh === 8 && r0.carried === 2, JSON.stringify(r0));
    const r3 = await scenario("r3", 3, 8, 5);
    bar("C5 reserve 3: 8 fresh + 0 carried", r3.fresh === 8 && r3.carried === 0, JSON.stringify(r3));
    const r9 = await scenario("r9", 9, 8, 0);
    bar("C6 fresh leads ignore the reserve: 8 of 8", r9.fresh === 8, JSON.stringify(r9));

    // C7 lowering to 0 stops carries on the next tick
    const low = await mkCampaign("lo", { carry: 1 });
    await setWidened(low, T);
    await db.execute(sql`UPDATE drip_campaign_configs SET carry_days = 0 WHERE campaign_id = ${low}`);
    const lowLead = await mkLead("lo", new Date(T.getTime() + 3600_000));
    await tick();
    bar("C7 carry lowered to 0: carried lead not admitted", (await journey(lowLead.id)) === undefined);
  } finally {
    if (orgId) {
      const name = (await one<{ name: string } | undefined>(
        sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
        fail++;
      } else {
        // lead_events → partner_keys is ON DELETE RESTRICT: clear the children first.
        await db.execute(sql`DELETE FROM drip_journeys WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_events WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM lead_events WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM drip_journeys WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left`);
      if (Number(left.n) !== 0) fail++;
    }
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
