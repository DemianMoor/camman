import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { createPartnerWithKey } from "./_partner-fixture";
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { runDripFollowups } from "@/lib/drip/followups";
import { selectDrainableStages } from "@/lib/sends/scheduled";

// Card 869ency4b item 6 — queue coupling, against the PREVIEW DB.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-drip-item6-queues.ts
//
//   F1 ⭐ a DUE Clicked follow-up is reached even with 250 older journeys whose
//      Ignored follow-up is not due yet (it used to sit behind the 200 oldest
//      rows by first_send_at)
//   F2 the not-due and wrong-lane rows no longer take slots at all
//   D1 ⭐ a drip stage (no scheduled_at, released via sent_at) is selected by the
//      shared drain even when more regular stages than maxStages are pending
//
// Throwaway org, deleted at the end. The follow-up children carry NO creative,
// so a reached row ends as mintRefused: nothing is ever queued or sent.

const MARKER = "__DRIP_ITEM6_QUEUES_TEST__";
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];

  const others = (await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM drip_journeys WHERE state = 'active'`)).n;
  if (others > 0) throw new Error(`REFUSING: ${others} active drip journey(s) already exist on preview`);

  const sfx = String(Date.now()).slice(-7);
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(
      sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${sfx}`}) RETURNING id`)).id;
    const org = sql`${orgId}::uuid`;
    await db.execute(sql`
      INSERT INTO org_settings (org_id, drip_enabled, drip_paused) VALUES (${org}, true, false)
      ON CONFLICT (org_id) DO UPDATE SET drip_enabled = true, drip_paused = false`);
    const keyId = (await createPartnerWithKey(db, { orgId, slug: "q6-" + sfx, name: "q6", token: "tokq6" + sfx })).keyId;

    // ── follow-ups ───────────────────────────────────────────────────────
    const campId = (await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
      VALUES (${org}, ${"q6-" + sfx}, 'q6 probe', 'active', 'drip', 'tracked') RETURNING id`)).id;
    await db.execute(sql`
      INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, behavioral_enabled)
      VALUES (${campId}, ${org}, ${"q6" + sfx}, true)`);
    const parentId = (await one<{ id: number }>(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, window_start_min, window_end_min, drip_active)
      VALUES (${org}, ${campId}, 1, 0, 1440, true) RETURNING id`)).id;
    for (const [tier, mins, n] of [[0, 1440, 98], [1, 60, 97]] as const) {
      await db.execute(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, parent_stage_id, behavioral_tier,
                                     drip_followup_minutes, drip_active, stage_number)
        VALUES (${org}, ${campId}, ${parentId}, ${tier}, ${mins}, true, ${n})`);
    }

    let seq = 0;
    const journey = async (firstSentMinAgo: number) => {
      seq++;
      const cid = (await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${org}, ${`+1995${sfx}${String(seq).padStart(4, "0")}`})
        RETURNING id`)).id;
      const le = (await one<{ id: string }>(sql`
        INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at)
        VALUES (${org}, ${cid}::uuid, ${keyId}, 'q6', now()) RETURNING id`)).id;
      await db.execute(sql`
        INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state, first_send_at, first_stage_id)
        VALUES (${org}, ${campId}, ${cid}::uuid, ${le}::uuid, 'active',
                now() - make_interval(mins => ${firstSentMinAgo}), ${parentId})`);
      return cid;
    };
    // 250 older journeys: no click, Ignored lane due only after 24 h.
    for (let i = 0; i < 250; i++) await journey(120);
    // The NEWEST journey clicked 80 min ago ⇒ its Clicked follow-up (60 min) is due.
    const clicker = await journey(90);
    const dest = (await one<{ id: number }>(sql`
      INSERT INTO link_destinations (org_id, url, url_hash)
      VALUES (${org}, ${"https://q6.example/" + sfx}, ${"q6h" + sfx}) RETURNING id`)).id;
    const sd = (await one<{ id: number }>(sql`SELECT id FROM short_domains LIMIT 1`)).id;
    const linkId = (await one<{ id: number }>(sql`
      INSERT INTO links (org_id, code, short_domain_id, destination_id, campaign_id, stage_id,
                         contact_id, send_token, campaign_tracking_id, stage_tracking_id)
      VALUES (${org}, ${"q6" + sfx.slice(-6)}, ${sd}, ${dest}, ${campId}, ${parentId},
              ${clicker}::uuid, ${"q6tok" + sfx}, 'x', 'y') RETURNING id`)).id;
    await db.execute(sql`
      INSERT INTO clicks (org_id, link_id, classification, clicked_at)
      VALUES (${org}, ${linkId}, 'human', now() - interval '80 minutes')`);

    const f = await runDripFollowups();
    bar("F1 ⭐ the due Clicked follow-up is reached behind 250 older not-due journeys",
      f.mintRefused === 1,
      `considered ${f.considered}, mintRefused (= reached, no creative) ${f.mintRefused}, notDue ${f.notDue}, tierMismatch ${f.tierMismatch}`);
    bar("F2 not-due and wrong-lane rows take no slots", f.considered === 1 && f.notDue === 0 && f.tierMismatch === 0,
      `considered ${f.considered}`);

    // ── shared drain ordering ─────────────────────────────────────────────
    const prov = (await one<{ id: number }>(sql`
      INSERT INTO sms_providers (sms_provider_id, org_id, name, adapter_code, supports_api_send, sends_enabled, send_paused)
      VALUES (${"q6p" + sfx}, ${org}, ${"Q6 " + sfx}, 'txh', true, true, false) RETURNING id`)).id;
    const contact = (await one<{ id: string }>(sql`SELECT id FROM contacts WHERE org_id = ${org} LIMIT 1`)).id;
    const pendingStage = async (cid: number, scheduledMinAgo: number | null, sentMinAgo: number | null) => {
      const s = (await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, send_approved, sms_provider_id,
                                     materialized_at, scheduled_at, sent_at)
        VALUES (${org}, ${cid}, ${100 + seq++}, true, ${prov}, now(),
                ${scheduledMinAgo == null ? null : sql`now() - make_interval(mins => ${scheduledMinAgo})`},
                ${sentMinAgo == null ? null : sql`now() - make_interval(mins => ${sentMinAgo})`})
        RETURNING id`)).id;
      await db.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
        VALUES (${org}, ${cid}, ${s}, ${contact}::uuid, '+10000000000', 'x', 'pending')`);
      return s;
    };
    const regular = (await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
      VALUES (${org}, ${"q6r-" + sfx}, 'q6 regular', 'active', 'regular', 'tracked') RETURNING id`)).id;
    for (let i = 0; i < 3; i++) await pendingStage(regular, 10 + i, null);
    // Drip stage: released (sent_at) an hour ago, never scheduled.
    const dripStage = await pendingStage(campId, null, 60);
    const picked = await selectDrainableStages(db, { now: new Date(), maxStages: 2, orgId });
    bar("D1 ⭐ a drip stage is selected even with more pending regular stages than maxStages",
      picked.some((p) => Number(p.stage_id) === dripStage),
      `picked ${JSON.stringify(picked.map((p) => p.stage_id))}, drip stage ${dripStage}`);
  } finally {
    if (orgId) {
      const name = (await one<{ name: string } | undefined>(
        sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM clicks WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM links WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM stage_sends WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM drip_journeys WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_events WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM drip_journeys WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left`);
      if (Number(left.n) !== 0) fail++;
    }
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
