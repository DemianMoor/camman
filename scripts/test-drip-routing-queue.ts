import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { createPartnerWithKey } from "./_partner-fixture";
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { runDripRoutingBatch } from "@/lib/drip/routing";

// Drip routing queue (card 869ency4b items 1-3), against the PREVIEW DB.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-routing-queue.ts
//
// Runs the REAL routing worker, scoped to a throwaway org (onlyOrgId), and
// asserts:
//   Q1  a dead lead gets a terminal 'unroutable' row on its FIRST evaluation
//   Q2  a lead whose tag matches no live-or-paused campaign is permanent too
//   Q3  a lead whose only campaign is PAUSED is deferred — no row, a re-check stamp
//   Q4  a contact already in a live journey is deferred, not closed
//   Q5  ⭐ head-of-line: 250 dead leads ahead of 10 good ones no longer starve them
//   Q6  a deferred lead is not re-evaluated before its re-check time
//   Q7  the admission cap holds within one tick (per-tick counts are incremented)
//   Q8  ⭐ freshness: yesterday's lead is never evaluated and never written to
//   Q9  a per-campaign cutoff override admits a lead the org default would not
//   Q9b ⭐ a cutoff set after the lead's window closed does not revive it
// The org (and everything under it) is deleted at the end.

const MARKER = "__DRIP_ROUTING_QUEUE_TEST__";
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
      orgId, slug: "rq-" + sfx, name: "rq", token: "tokrq" + sfx,
    })).keyId;

    const mkCampaign = async (tag: string, status: string, cfg: { admissionCap?: number; cutoff?: number } = {}) => {
      const id = (await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type)
        VALUES (${orgId}::uuid, ${`rq-${sfx}-${tag}`}, ${`RQ ${tag}`}, ${status}, 'drip') RETURNING id`)).id;
      await db.execute(sql`
        INSERT INTO drip_campaign_configs
          (campaign_id, org_id, interest_tag, routing_daily_admission_cap, admission_cutoff_minutes)
        VALUES (${id}, ${orgId}::uuid, ${tag}, ${cfg.admissionCap ?? null}, ${cfg.cutoff ?? null})`);
      return id;
    };
    let phoneN = 0;
    const mkLead = async (tag: string, receivedAt: Date, opts: { optedOut?: boolean } = {}) => {
      phoneN++;
      const contactId = (await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${`+1996${sfx}${String(phoneN).padStart(4, "0")}`})
        RETURNING id`)).id;
      if (opts.optedOut) {
        await db.execute(sql`
          INSERT INTO opt_outs (org_id, contact_id, phone_number)
          SELECT ${orgId}::uuid, id, phone_number FROM contacts WHERE id = ${contactId}::uuid`);
      }
      const id = (await one<{ id: string }>(sql`
        INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, interest_tag, received_at)
        VALUES (${orgId}::uuid, ${contactId}::uuid, ${keyId}, 'rq', ${tag}, ${receivedAt.toISOString()}::timestamptz)
        RETURNING id`)).id;
      return { id, contactId };
    };
    const journeyOf = async (leadId: string) =>
      one<{ state: string; campaign_id: number | null } | undefined>(sql`
        SELECT state, campaign_id FROM drip_journeys WHERE lead_event_id = ${leadId}::uuid`);
    const recheckOf = async (leadId: string) =>
      (await one<{ r: string | null }>(sql`SELECT drip_recheck_at::text AS r FROM lead_events WHERE id = ${leadId}::uuid`)).r;
    const tick = (batchSize = 600) => runDripRoutingBatch(new Date(), { onlyOrgId: orgId, batchSize });

    const now = Date.now();
    const at = (minAgo: number) => new Date(now - minAgo * 60_000);
    const todayStart = campaignDayBoundsUtc(new Date(now)).start.getTime();
    // Keep "today" leads inside today even right after ET midnight.
    const minsIntoDay = Math.floor((now - todayStart) / 60_000);
    const todayAgo = (m: number) => at(Math.min(m, Math.max(0, minsIntoDay - 1)));

    const campA = await mkCampaign(`A${sfx}`, "active");
    await mkCampaign(`P${sfx}`, "paused"); // the only campaign for tag P — paused
    const campCap = await mkCampaign(`C${sfx}`, "active", { admissionCap: 3 });

    // ── Q1–Q4 ────────────────────────────────────────────────────────────
    const dead = await mkLead(`A${sfx}`, todayAgo(30), { optedOut: true });
    const noCampaign = await mkLead(`ZZ${sfx}`, todayAgo(30));
    const pausedOnly = await mkLead(`P${sfx}`, todayAgo(30));
    const good = await mkLead(`A${sfx}`, todayAgo(29));
    // Same contact as `good`, arriving again: in use once `good` is routed.
    const again = (await one<{ id: string }>(sql`
      INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, interest_tag, received_at)
      VALUES (${orgId}::uuid, ${good.contactId}::uuid, ${keyId}, 'rq', ${`A${sfx}`}, ${todayAgo(28).toISOString()}::timestamptz)
      RETURNING id`)).id;

    const r1 = await tick();
    console.log(`  tick 1: ${JSON.stringify({ considered: r1.considered, routed: r1.routed, unroutable: r1.markedUnroutable, deferred: r1.deferred, ms: r1.elapsedMs })}\n`);
    const jDead = await journeyOf(dead.id);
    bar("Q1 opted-out lead → terminal 'unroutable' on its FIRST evaluation", jDead?.state === "unroutable", JSON.stringify(jDead));
    const jNo = await journeyOf(noCampaign.id);
    bar("Q2 tag with no live-or-paused campaign → 'unroutable'", jNo?.state === "unroutable", JSON.stringify(jNo));
    const jPaused = await journeyOf(pausedOnly.id);
    bar("Q3 only campaign PAUSED → deferred (no row, re-check stamped)",
      jPaused === undefined && (await recheckOf(pausedOnly.id)) !== null, `journey ${JSON.stringify(jPaused)}`);
    bar("    the good lead is routed to campaign A", (await journeyOf(good.id))?.campaign_id === campA);
    bar("Q4 a second arrival of an in-journey contact → deferred, not closed",
      (await journeyOf(again)) === undefined && (await recheckOf(again)) !== null);

    // ── Q6: deferred leads are not re-evaluated before their time ─────────
    const r2 = await tick();
    bar("Q6 an immediate second tick evaluates nothing (deferred leads wait)", r2.considered === 0,
      `considered ${r2.considered}`);

    // ── Q5: head-of-line ──────────────────────────────────────────────────
    for (let i = 0; i < 250; i++) await mkLead(`A${sfx}`, todayAgo(20), { optedOut: true });
    const late: string[] = [];
    for (let i = 0; i < 10; i++) late.push((await mkLead(`A${sfx}`, todayAgo(10))).id);
    const ticks = [];
    for (let i = 0; i < 3; i++) ticks.push(await tick(100));
    const lateRouted = (await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM drip_journeys
      WHERE lead_event_id = ANY(${`{${late.join(",")}}`}::uuid[]) AND state = 'routed'`)).n;
    const evaluations = ticks.reduce((a, t) => a + t.considered, 0);
    bar("Q5 ⭐ 250 dead leads ahead of 10 good ones: all 10 routed within 3 ticks of 100",
      lateRouted === 10, `routed ${lateRouted}/10; ${evaluations} evaluations (each dead lead once)`);
    bar("    each dead lead evaluated exactly once (260 evaluations, no re-checks)", evaluations === 260,
      `${evaluations}`);

    // ── Q7: admission cap within one tick ─────────────────────────────────
    const capLeads: string[] = [];
    for (let i = 0; i < 5; i++) capLeads.push((await mkLead(`C${sfx}`, todayAgo(5))).id);
    const r7 = await tick();
    const capRouted = (await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM drip_journeys WHERE campaign_id = ${campCap} AND state = 'routed'`)).n;
    bar("Q7 admission cap 3, five leads in one tick → 3 routed, 2 deferred",
      capRouted === 3 && r7.deferred === 2, `routed ${capRouted}, deferred ${r7.deferred}`);

    // ── Q8/Q9: freshness ──────────────────────────────────────────────────
    const yesterday = new Date(todayStart - 60 * 60_000); // 23:00 ET yesterday
    const stale = await mkLead(`A${sfx}`, yesterday);
    const r8 = await tick();
    bar("Q8 ⭐ yesterday's lead is never evaluated and never written to",
      (await journeyOf(stale.id)) === undefined && (await recheckOf(stale.id)) === null && r8.considered === 0,
      `considered ${r8.considered}`);

    // Override: campaign L admits until (minutes into today + 60) after the end
    // of the arrival day ⇒ yesterday's lead is still admissible right now.
    const campLate = await mkCampaign(`L${sfx}`, "active", { cutoff: minsIntoDay + 60 });
    // Spec §4.2 (0204): an INSERT with window > 0 stamps admission_widened_at = now(),
    // and a lead that arrived before it gets window 0. Backdate the stamp so the
    // override predates the lead — the case this check is about. 0205: stamps are
    // forward-only, so the backdate needs the test-only hatch in a transaction.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL camman.allow_widened_backdate = 'on'`);
      await tx.execute(sql`
        UPDATE drip_campaign_configs
        SET admission_widened_at = ${new Date(yesterday.getTime() - 60 * 60_000).toISOString()}::timestamptz
        WHERE campaign_id = ${campLate}`);
    });
    const staleL = await mkLead(`L${sfx}`, yesterday);
    await tick();
    bar("Q9 a per-campaign cutoff override admits yesterday's lead to that campaign",
      (await journeyOf(staleL.id))?.campaign_id === campLate);
    bar("    …while yesterday's lead for a default-cutoff campaign stays untouched",
      (await journeyOf(stale.id)) === undefined);

    // Same cutoff, NOT backdated: set after the lead's window closed ⇒ no revival.
    await mkCampaign(`M${sfx}`, "active", { cutoff: minsIntoDay + 60 });
    const staleM = await mkLead(`M${sfx}`, yesterday);
    await tick();
    bar("Q9b ⭐ a cutoff set AFTER the lead's window closed does not revive it (0204 widened_at)",
      (await journeyOf(staleM.id)) === undefined);
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
