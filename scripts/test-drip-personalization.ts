// P5 Task 2: drip senders render per lead (spec "P5 owner rules").
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-personalization.ts
// PURE  D.*  renderDripBody — the per-lead decision both producers make
// DB    S.*  recordDripTagSkip on the preview DB, rolled back
// SRC   G.*  both producers use them in the right place; the interim is gone
// (runDripSchedulerBatch runs across every org on the shared preview DB, so it
// is not driven end-to-end here — see scripts/test-format-interim.ts.)
import "./_env-preload";
import "./_require-preview-db"; // MUST be second
import { createPartnerWithKey } from "./_partner-fixture";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { T1_TEMPLATE } from "@/lib/messages/format";
import { renderMessage } from "@/lib/messages/render";
import { NO_RECIPIENT } from "@/lib/messages/tags";
import { dripDailySendsPredicate } from "@/lib/drip/daily-sends";
import { recordDripTagSkip, renderDripBody } from "@/lib/drip/personalize-drip";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const ROLLBACK = Symbol("rollback");

function pure() {
  console.log("D — renderDripBody (pure)");
  const shape = { kind: "template" as const, formatId: 1, template: T1_TEMPLATE };
  const base = { shape, brandName: "Acme", linkUrl: "https://x.co/r/ABCDEFG", stopText: "Reply STOP to opt out" };
  const jose = { first_name: "Jose", zip: null, state: null };
  const ok = renderDripBody({ ...base, creativeText: "Hi {first_name}", recipient: jose, allowMultiSegment: false });
  bar("D1 lead with the data ⇒ personalized body", ok.ok && ok.body.startsWith("Acme: Hi Jose\n"), JSON.stringify(ok));
  const miss = renderDripBody({ ...base, creativeText: "Hi {first_name}, {zip} deals", recipient: { first_name: null, zip: "12345", state: null }, allowMultiSegment: false });
  bar("D2 missing first_name ⇒ missing_tag:first_name, attempted body keeps {first_name} literal",
    !miss.ok && miss.reason === "missing_tag:first_name" && miss.attempted.startsWith("Acme: Hi {first_name}, 12345 deals"), JSON.stringify(miss));
  const long = `Hi {first_name} ${"a".repeat(120)}`;
  const seg1 = renderDripBody({ ...base, creativeText: long, recipient: { first_name: "Abcdefghijklmno", zip: null, state: null }, allowMultiSegment: false });
  bar("D3 personalized body over 1 segment, allow_multi_segment=false ⇒ segment_limit", !seg1.ok && seg1.reason === "segment_limit", JSON.stringify(seg1).slice(0, 120));
  const seg2 = renderDripBody({ ...base, creativeText: long, recipient: { first_name: "Abcdefghijklmno", zip: null, state: null }, allowMultiSegment: true });
  bar("D4 same body with allow_multi_segment=true ⇒ sent", seg2.ok);
  const plainLong = `Plain ${"a".repeat(200)}`;
  const tagless = renderDripBody({ ...base, creativeText: plainLong, recipient: jose, allowMultiSegment: false });
  const legacy = renderMessage({ ...base, creativeText: plainLong, recipient: NO_RECIPIENT });
  bar("D5 tag-less body: byte-identical to the pre-P5 render, and NOT segment-checked (drip never was)",
    tagless.ok && legacy.ok && tagless.body === legacy.body);
}

async function db_() {
  console.log("\nS — recordDripTagSkip (preview, rolled back)");
  try {
    await db.transaction(async (tx) => {
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const sfx = Date.now().toString().slice(-8);
      const org = (await one<{ id: string }>(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)).id;
      const camp = (await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type, link_mode) VALUES (${org}, ${"dp-" + sfx}, 'dp', 'active', 'drip', 'tracked') RETURNING id`)).id;
      const stage = (await one<{ id: number }>(sql`INSERT INTO campaign_stages (org_id, campaign_id) VALUES (${org}, ${camp}) RETURNING id`)).id;
      const child = (await one<{ id: number }>(sql`INSERT INTO campaign_stages (org_id, campaign_id, parent_stage_id) VALUES (${org}, ${camp}, ${stage}) RETURNING id`)).id;
      const lead = await one<{ contact_id: string; phone: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${org}, ${"+1911" + sfx}) RETURNING id AS contact_id, phone_number AS phone`);
      const keyId = (await createPartnerWithKey(tx, { orgId: org, slug: "dp-" + sfx, name: "dp", token: "tokdp" + sfx })).keyId;
      const ev = await one<{ id: string }>(sql`
        INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, interest_tag, received_at)
        VALUES (${org}, ${lead.contact_id}, ${keyId}, 'dp', 'DP', now()) RETURNING id`);
      const j = await one<{ id: string }>(sql`
        INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state) VALUES (${org}, ${camp}, ${lead.contact_id}, ${ev.id}, 'routed') RETURNING id`);
      const stamp = { messageFormatId: null, formatCustom: false };

      const w1 = await recordDripTagSkip(tx, { orgId: org, campaignId: camp, stageId: stage, lead, reason: "missing_tag:first_name", renderedText: "Acme: Hi {first_name}", stamp, exitJourneyId: j.id });
      const jr = await one<{ state: string; close_reason: string | null; closed_at: string | null }>(sql`SELECT state, close_reason, closed_at FROM drip_journeys WHERE id = ${j.id}`);
      const row = await one<{ status: string; last_error: string; rendered_text: string; link_id: number | null }>(sql`
        SELECT status, last_error, rendered_text, link_id FROM stage_sends WHERE stage_id = ${stage}`);
      bar("S1 first-send skip ⇒ skipped_ineligible row (missing_tag:first_name, attempted body, no link) + journey exited/close_reason",
        w1 === 1 && row.status === "skipped_ineligible" && row.last_error === "missing_tag:first_name" && row.rendered_text === "Acme: Hi {first_name}"
          && row.link_id === null && jr.state === "exited" && jr.close_reason === "missing_tag:first_name" && jr.closed_at !== null,
        JSON.stringify({ w1, row, jr }));

      const w2 = await recordDripTagSkip(tx, { orgId: org, campaignId: camp, stageId: child, lead, reason: "segment_limit", renderedText: "x", stamp, exitJourneyId: null });
      const again = await recordDripTagSkip(tx, { orgId: org, campaignId: camp, stageId: child, lead, reason: "segment_limit", renderedText: "x", stamp, exitJourneyId: null });
      const fu = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM stage_sends WHERE stage_id = ${child}`);
      bar("S2 follow-up skip ⇒ ONE row only (idempotent), journey untouched by it", w2 === 1 && again === 0 && fu.n === 1);

      const day = new Date(Date.now() - 86400000), dayEnd = new Date(Date.now() + 86400000);
      const capped = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM stage_sends ss WHERE ss.campaign_id = ${camp} AND ${dripDailySendsPredicate(day, dayEnd)}`);
      const exp = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM offer_exposures WHERE contact_id = ${lead.contact_id}`);
      const cexp = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM creative_exposures WHERE contact_id = ${lead.contact_id}`);
      bar("S3 skip rows don't count toward the daily cap and create no exposures", capped.n === 0 && exp.n === 0 && cexp.n === 0, JSON.stringify({ capped, exp, cexp }));
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

function sources() {
  console.log("\nG — producers");
  const sched = strip(readFileSync("lib/drip/scheduler.ts", "utf8"));
  const fol = strip(readFileSync("lib/drip/followups.ts", "utf8"));
  const one = strip(readFileSync("lib/drip/send-one.ts", "utf8"));
  bar("G1 scheduler renders per lead with renderDripBody", sched.includes("renderDripBody("));
  bar("G2 scheduler: a first-send skip exits the journey (exitJourneyId: lead.journey_id)", /recordDripTagSkip\([\s\S]{0,400}exitJourneyId:\s*lead\.journey_id/.test(sched));
  bar("G3 follow-ups render via dispatchDripSend → renderDripBody", one.includes("renderDripBody(") && fol.includes("dispatchDripSend("));
  bar("G4 follow-ups: a skip writes the row only (exitJourneyId: null)", /recordDripTagSkip\([\s\S]{0,400}exitJourneyId:\s*null/.test(fol));
  let hits = "";
  try { hits = execSync("git grep -l tags_not_supported_yet -- lib/drip lib/sends", { encoding: "utf8" }).trim(); } catch { /* no match */ }
  bar("G5 `tags_not_supported_yet` is gone from lib/drip and lib/sends", hits === "", hits);
}

async function main() {
  pure();
  await db_();
  sources();
  await pgConn.end({ timeout: 5 });
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
