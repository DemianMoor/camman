// scripts/test-kickoff-formats.ts — kickoff renders each stage with ITS message
// shape and stamps the rows (0216), and refuses a tagged message (interim).
// Fixture recipe from scripts/test-kickoff-segments.ts. Rolled back.
// Expected bodies are written out LITERALLY, not via the renderer under test.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-kickoff-formats.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { kickoffStageSend } from "@/lib/sends/kickoff";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

// Telegram: fake config + a fetch stub that counts alert calls and never leaves the process.
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";
let telegramCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("api.telegram.org")) {
    telegramCalls++;
    return new Response("{}", { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function main() {
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const org = await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
      const orgId = org.id;
      const brand = await one<{ id: number; name: string }>(sql`
        SELECT b.id, b.name FROM brands b
        JOIN short_domains sd ON sd.brand_id = b.id AND sd.status = 'active'
        WHERE b.org_id = ${orgId} LIMIT 1`);
      if (!brand) { console.log("SKIP: need a brand with an active short domain"); throw ROLLBACK; }
      const t2 = await one<{ id: number }>(sql`SELECT id FROM message_formats WHERE org_id = ${orgId} AND name LIKE 'T2%'`);
      const t1 = await one<{ id: number }>(sql`SELECT id FROM message_formats WHERE org_id = ${orgId} AND is_default`);

      const prov = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"kfmt-" + sfx}, ${orgId}, ${"kfmt"}, true) RETURNING id`);
      await tx.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key) VALUES (${orgId}, ${prov.id}, NULL, ${"k"})`);
      // A sending number: kickoff refuses a stage without one (no_sender_number).
      const phone = await one<{ id: number }>(sql`
        INSERT INTO provider_phones (org_id, provider_id, brand_id, phone_number) VALUES (${orgId}, ${prov.id}, ${brand.id}, ${"+1901" + sfx}) RETURNING id`);
      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, tracking_id)
        VALUES (${orgId}, ${"kfmt-camp-" + sfx}, ${"kfmt"}, 'active', 'tracked', ${brand.id}, ${"9_99_kfmt_" + sfx}) RETURNING id`);
      const campaignId = camp.id;

      async function mkCase(n: number, text: string, shape: { formatId?: number; custom?: string }) {
        const cre = await one<{ id: number }>(sql`
          INSERT INTO creatives (slug, org_id, text, status) VALUES (${"kfmt-cre-" + sfx + "-" + n}, ${orgId}, ${text}, 'active')
          RETURNING id`);
        const trackingId = `9_99_kfmt_${sfx}_s${n}`;
        const stage = await one<{ id: number }>(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, creative_id, sms_provider_id, provider_phone_id, send_approved,
             tracking_id, full_url, include_no_status, stop_text, scheduled_at, message_format_id, custom_text)
          VALUES (${orgId}, ${campaignId}, ${n}, ${cre.id}, ${prov.id}, ${phone.id}, true,
             ${trackingId}, ${`https://offer.example.com/x?sub_id3=${trackingId}`}, true, ${"STOP"}, now(),
             ${shape.formatId ?? null}, ${shape.custom ?? null})
          RETURNING id`);
        const contact = await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1556" + sfx + n}) RETURNING id`);
        await tx.execute(sql`
          INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot)
          VALUES (${orgId}, ${campaignId}, ${contact.id}, true, false)`);
        return stage.id;
      }
      const rowOf = async (stageId: number) => one<{ body: string; url: string; fid: number | null; custom: boolean }>(sql`
        SELECT ss.rendered_text AS body, 'https://' || sd.domain || '/r/' || l.code AS url,
               ss.message_format_id AS fid, ss.format_custom AS custom
        FROM stage_sends ss JOIN links l ON l.id = ss.link_id JOIN short_domains sd ON sd.id = l.short_domain_id
        WHERE ss.stage_id = ${stageId}`);

      const sT1 = await mkCase(1, "Hi", {});
      const rT1 = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId: sT1 });
      const r1 = rT1.ok ? await rowOf(sT1) : undefined;
      check("K1 default (T1) stage: body = '<brand>: Hi\\n<url>\\nSTOP', stamped with T1, not custom",
        rT1.ok && !!r1 && r1.body === `${brand.name}: Hi\n${r1.url}\nSTOP` && r1.fid === t1.id && r1.custom === false,
        JSON.stringify({ rT1, r1 }));

      const sT2 = await mkCase(2, "Hi", { formatId: t2.id });
      const rT2 = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId: sT2 });
      const r2 = rT2.ok ? await rowOf(sT2) : undefined;
      check("K2 T2 stage: body = 'Hi <brand> STOP\\n\\n<url>', stamped with T2",
        rT2.ok && !!r2 && r2.body === `Hi ${brand.name} STOP\n\n${r2.url}` && r2.fid === t2.id && r2.custom === false,
        JSON.stringify({ rT2, r2 }));

      const sC = await mkCase(3, "Hi", { custom: "Hey!<new_row>{creative_text}<new_row>{url}<new_row>{stop_text}" });
      const rC = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId: sC });
      const r3 = rC.ok ? await rowOf(sC) : undefined;
      check("K3 custom-text stage: body = 'Hey!\\nHi\\n<url>\\nSTOP', format_custom true, no format id",
        rC.ok && !!r3 && r3.body === `Hey!\nHi\n${r3.url}\nSTOP` && r3.fid === null && r3.custom === true,
        JSON.stringify({ rC, r3 }));

      telegramCalls = 0;
      const sTag = await mkCase(4, "Hi {first_name}", {});
      const rTag = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId: sTag });
      const nTag = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM stage_sends WHERE stage_id = ${sTag}`);
      await new Promise((r) => setTimeout(r, 50)); // the alert is fire-and-forget
      check("M4.1 regular stage with {first_name} ⇒ refused tags_not_supported_yet, 0 rows, 1 Telegram alert",
        !rTag.ok && rTag.reason === "tags_not_supported_yet" && nTag.n === 0 && telegramCalls === 1,
        JSON.stringify({ rTag, rows: nTag.n, telegramCalls }));

      const sLit = await mkCase(5, "Hi {FirstName}", {});
      const rLit = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId: sLit });
      const r5 = rLit.ok ? await rowOf(sLit) : undefined;
      check("M4.2 creative-637 shape '{FirstName}' is literal text, not a tag ⇒ sends",
        rLit.ok && !!r5 && r5.body === `${brand.name}: Hi {FirstName}\n${r5.url}\nSTOP`, JSON.stringify({ rLit, r5 }));

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  globalThis.fetch = realFetch;
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
