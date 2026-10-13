import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { createPartnerWithKey } from "./_partner-fixture";
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { runDripRoutingBatch } from "@/lib/drip/routing";

// Drip routing send capacity / capacity overflow (0210), against the PREVIEW DB.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-routing-overflow.ts
//
// Runs the REAL routing worker scoped to a throwaway org (onlyOrgId). Each
// scenario uses its own interest tag so the campaigns never see each other.
//   R1  flag OFF: a send-full campaign still wins (routing ignores the send cap — unchanged)
//   R2  flag ON: the send-full campaign is skipped, the lead overflows to the sibling,
//       and the journey records overflowed_from with "campaign full (X/Y today …)"
//   R3  every candidate full ⇒ deferred (no journey, re-check stamped)
//   R4  the open sibling's filter rejects the lead ⇒ deferred, NOT overflowed past its filters
//   R5  paused priority campaign ⇒ next eligible wins, and it is NOT recorded as an overflow
//   R6  within ONE tick the priority campaign fills after exactly its room, then overflow
//   R7  ⭐ the 8_155 / 8_154 replay, scaled 1:100 (caps, filters, priorities, S and U as on
//       2026-10-13): with 8_154 active it fills to its cap and nothing new reaches 8_155;
//       8_155's existing backlog stays where it is; with 8_154 paused everything defers.
// The org (and everything under it) is deleted at the end.

const MARKER = "__DRIP_ROUTING_OVERFLOW_TEST__";
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];

  const sfx = String(Date.now()).slice(-6);
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(
      sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${sfx}`}) RETURNING id`)).id;
    await db.execute(sql`
      INSERT INTO org_settings (org_id, drip_enabled, drip_paused)
      VALUES (${orgId}::uuid, true, false)
      ON CONFLICT (org_id) DO UPDATE SET drip_enabled = true, drip_paused = false`);
    const setFlag = (on: boolean) => db.execute(sql`
      UPDATE org_settings SET drip_routing_send_capacity = ${on} WHERE org_id = ${orgId}::uuid`);
    const keyId = (await createPartnerWithKey(db, {
      orgId, slug: "ro-" + sfx, name: "ro", token: "tokro" + sfx,
    })).keyId;

    let phoneSeq = 0;
    const phone = () => `+1995${sfx}${String(++phoneSeq).padStart(4, "0")}`;

    const mkCampaign = async (
      tag: string, label: string, priority: number, dailyCap: number,
      o: { status?: string; filters?: Record<string, unknown> } = {},
    ) => {
      const id = (await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type)
        VALUES (${orgId}::uuid, ${`ro-${sfx}-${tag}-${label}`}, ${`RO ${tag} ${label}`},
                ${o.status ?? "active"}, 'drip') RETURNING id`)).id;
      await db.execute(sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, priority, daily_cap, filters)
        VALUES (${id}, ${orgId}::uuid, ${tag}, ${priority}, ${dailyCap},
                ${JSON.stringify(o.filters ?? {})}::jsonb)`);
      return id;
    };
    const setStatus = (id: number, status: string) =>
      db.execute(sql`UPDATE campaigns SET status = ${status} WHERE id = ${id}`);

    /** S: n of today's sends on the campaign (status 'sent', created now). */
    const seedSends = async (campaignId: number, n: number) => {
      if (n === 0) return;
      const stage = (await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, window_start_min, window_end_min, drip_active)
        VALUES (${orgId}::uuid, ${campaignId}, 1, 0, 1440, false) RETURNING id`)).id;
      for (let i = 0; i < n; i++) {
        const c = (await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${phone()}) RETURNING id`)).id;
        await db.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, created_at, sent_at)
          VALUES (${orgId}::uuid, ${campaignId}, ${stage}, ${c}::uuid, '+15550000000', 'hi', 'sent', now(), now())`);
      }
    };
    /** U: n routed-unsent journeys already on the campaign (the backlog). */
    const seedBacklog = async (campaignId: number, tag: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const c = (await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${phone()}) RETURNING id`)).id;
        const ev = (await one<{ id: string }>(sql`
          INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, interest_tag, received_at)
          VALUES (${orgId}::uuid, ${c}::uuid, ${keyId}, 'ro', ${tag}, now()) RETURNING id`)).id;
        await db.execute(sql`
          INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state, routed_at, reason, carried_days)
          VALUES (${orgId}::uuid, ${campaignId}, ${c}::uuid, ${ev}::uuid, 'routed', now(), '{}'::jsonb, 0)`);
      }
    };
    const mkLead = async (tag: string, state: string | null = "TX") => {
      const c = (await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${phone()}) RETURNING id`)).id;
      if (state) {
        await db.execute(sql`
          INSERT INTO contact_attributes (contact_id, org_id, state, country)
          VALUES (${c}::uuid, ${orgId}::uuid, ${state}, 'US')`);
      }
      return (await one<{ id: string }>(sql`
        INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, interest_tag, received_at)
        VALUES (${orgId}::uuid, ${c}::uuid, ${keyId}, 'ro', ${tag}, now()) RETURNING id`)).id;
    };
    type J = { state: string; campaign_id: number | null; reason: Record<string, unknown> } | undefined;
    const journeyOf = (leadId: string) => one<J>(sql`
      SELECT state, campaign_id, reason FROM drip_journeys WHERE lead_event_id = ${leadId}::uuid`);
    const recheckOf = async (leadId: string) =>
      (await one<{ r: string | null }>(sql`SELECT drip_recheck_at::text AS r FROM lead_events WHERE id = ${leadId}::uuid`)).r;
    const deferred = async (leadId: string) =>
      (await journeyOf(leadId)) === undefined && (await recheckOf(leadId)) !== null;
    const routedTo = async (ids: string[], campaignId: number) => {
      let n = 0;
      for (const id of ids) if ((await journeyOf(id))?.campaign_id === campaignId) n++;
      return n;
    };
    const journeysOn = async (campaignId: number) => (await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM drip_journeys WHERE campaign_id = ${campaignId}`)).n;
    const tick = () => runDripRoutingBatch(new Date(), { onlyOrgId: orgId });

    // ── R1 / R2: one full priority campaign, one open sibling ─────────────
    const t1 = `a${sfx}`;
    const a1 = await mkCampaign(t1, "A", 97, 10);
    const b1 = await mkCampaign(t1, "B", 100, 1000);
    await seedSends(a1, 10); // S = 10 = cap ⇒ full

    await setFlag(false);
    const l1 = await mkLead(t1);
    await tick();
    const j1 = await journeyOf(l1);
    bar("R1 flag OFF: the send-full priority campaign still wins (unchanged)",
      j1?.campaign_id === a1 && !("overflowed_from" in (j1?.reason ?? {})), JSON.stringify(j1?.campaign_id));

    await setFlag(true);
    const l2 = await mkLead(t1);
    await tick();
    const j2 = await journeyOf(l2);
    const of2 = (j2?.reason.overflowed_from ?? []) as { campaign_id: number; detail: string }[];
    bar("R2 flag ON: the lead overflows to the sibling", j2?.campaign_id === b1, JSON.stringify(j2?.campaign_id));
    // S = 10, and U = 1 (R1's lead is routed and unsent).
    bar("    overflowed_from names the full campaign with X/Y",
      of2.length === 1 && of2[0].campaign_id === a1 &&
      of2[0].detail === "campaign full (11/10 today: 10 sent + 1 queued)", JSON.stringify(of2));
    bar("    and the winner's name is stored for the display",
      j2?.reason.campaign_name === `RO ${t1} B`, String(j2?.reason.campaign_name));

    // ── R3: every candidate full ─────────────────────────────────────────
    const t3 = `c${sfx}`;
    const a3 = await mkCampaign(t3, "A", 97, 2);
    const b3 = await mkCampaign(t3, "B", 100, 3);
    await seedSends(a3, 2);
    await seedBacklog(b3, t3, 3);
    const l3 = await mkLead(t3);
    await tick();
    bar("R3 every candidate full ⇒ deferred (no journey, re-check stamped)", await deferred(l3));

    // ── R4: the open sibling's filter rejects the lead ───────────────────
    const t4 = `d${sfx}`;
    const a4 = await mkCampaign(t4, "A", 97, 1);
    await mkCampaign(t4, "B", 100, 1000, { filters: { state: ["CA"], state_mode: "exclude" } });
    await seedSends(a4, 1);
    const l4 = await mkLead(t4, "CA");
    await tick();
    bar("R4 sibling's own filter rejects the lead ⇒ deferred, not overflowed", await deferred(l4));

    // ── R5: paused priority campaign — behaviour as live ─────────────────
    const t5 = `e${sfx}`;
    await mkCampaign(t5, "A", 97, 1000, { status: "paused" });
    const b5 = await mkCampaign(t5, "B", 100, 1000);
    const l5 = await mkLead(t5);
    await tick();
    const j5 = await journeyOf(l5);
    bar("R5 paused priority campaign ⇒ next eligible wins, NOT recorded as overflow",
      j5?.campaign_id === b5 && !("overflowed_from" in (j5?.reason ?? {})), JSON.stringify(j5?.reason));

    // ── R6: fills within one tick ────────────────────────────────────────
    const t6 = `f${sfx}`;
    const a6 = await mkCampaign(t6, "A", 97, 5);
    const b6 = await mkCampaign(t6, "B", 100, 1000);
    const l6: string[] = [];
    for (let i = 0; i < 8; i++) l6.push(await mkLead(t6));
    await tick();
    const toA6 = await routedTo(l6, a6);
    const toB6 = await routedTo(l6, b6);
    bar("R6 one tick: priority campaign takes exactly its room (5), the rest (3) overflow",
      toA6 === 5 && toB6 === 3, `A ${toA6}, B ${toB6}`);

    // ── R7: the 8_155 / 8_154 replay, scaled 1:100 ───────────────────────
    // 10-13 14:22 ET: 8_154 cap 5,000, S 3,594, U 0, priority 97, excludes CA…;
    //                 8_155 cap 7,000, S 7,000, U 15,647, priority 100, excludes NM/WA/WV…
    const t7 = `m${sfx}`;
    const c154 = await mkCampaign(t7, "8_154", 97, 50, {
      filters: { state: ["AK", "CA", "CT", "DC", "HI", "MA", "ME", "MN", "NY", "RI", "VT"], country: ["US"], state_mode: "exclude" },
    });
    const c155 = await mkCampaign(t7, "8_155", 100, 70, {
      filters: { state: ["AK", "CT", "DC", "HI", "MA", "ME", "MN", "NM", "NY", "RI", "VT", "WA", "WV"], country: ["US"], state_mode: "exclude" },
    });
    await seedSends(c154, 36);
    await seedSends(c155, 70);
    await seedBacklog(c155, t7, 156);
    const backlogBefore = await journeysOn(c155);

    const tx: string[] = [], ca: string[] = [], nm: string[] = [];
    for (let i = 0; i < 20; i++) tx.push(await mkLead(t7, "TX"));
    for (let i = 0; i < 3; i++) ca.push(await mkLead(t7, "CA"));
    for (let i = 0; i < 3; i++) nm.push(await mkLead(t7, "NM"));
    await tick();
    const all7 = [...tx, ...ca, ...nm];
    const to154 = await routedTo(all7, c154);
    const to155 = await routedTo(all7, c155);
    let def7 = 0;
    for (const id of all7) if (await deferred(id)) def7++;
    bar("R7a 8_154 active: it fills to exactly its room (50 − 36 = 14)", to154 === 14, `${to154}`);
    bar("    nothing new reaches the full 8_155", to155 === 0, `${to155}`);
    bar("    the other 12 are deferred (CA can only go to 8_155, which is full)", def7 === 12, `${def7}`);
    bar("    every CA lead is deferred", (await Promise.all(ca.map(deferred))).every(Boolean));
    bar("    8_155's existing backlog is untouched (no re-routing)",
      (await journeysOn(c155)) === backlogBefore, `${await journeysOn(c155)} vs ${backlogBefore}`);

    await setStatus(c154, "paused");
    const late: string[] = [];
    for (let i = 0; i < 5; i++) late.push(await mkLead(t7, "TX"));
    await tick();
    bar("R7b 8_154 paused + 8_155 full ⇒ every new lead deferred",
      (await Promise.all(late.map(deferred))).every(Boolean));
  } finally {
    if (orgId) {
      const name = (await one<{ name: string } | undefined>(
        sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM stage_sends WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM drip_journeys WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_events WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM lead_events WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM drip_journeys WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM stage_sends WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left`);
      if (Number(left.n) !== 0) fail++;
    }
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
