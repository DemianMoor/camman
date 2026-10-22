// P5 Task 1: the routing rule `creative_tags` (spec "P5 owner rules").
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-routing-tags.ts
// evaluateLeadRouting against fixtures in an always-rolled-back transaction.
//   R1 lead without first_name, P1 needs {first_name}, P2 doesn't ⇒ routed to P2;
//      P1 carries creative_tags = missing, detail "missing data: first_name"
//   R2 only P1 left ⇒ outcome PERMANENT (unroutable)
//   R3 a tag-less campaign has NO creative_tags key (stored reason byte-identical)
//   R4 a 15-character name with L = 12 ⇒ detail "segment limit (first_name 15 > 12)"
//   R5 a follow-up child's {first_name} does NOT add the rule to its campaign
//   R6 the worker's per-tick cache and the tool's "load" mode give the same verdict
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { createPartnerWithKey } from "./_partner-fixture";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { firstNameMaxLength, shapeFromStage } from "@/lib/messages/render";
import { classifyRoutingOutcome, evaluateLeadRouting } from "@/lib/drip/routing-eval";
import { loadCampaignTagRules } from "@/lib/sends/tag-rules";
import { resolveOptOutFooter } from "@/lib/sends/opt-out-footer";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
class Rollback extends Error {}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}`);
  try {
    await db.transaction(async (tx) => {
      const T = tx as unknown as typeof db;
      const one = async <X>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as X[])[0];
      const orgId = (await one<{ id: string }>(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)).id;
      const sfx = String(Date.now()).slice(-7);
      const tag = `TAGR${sfx}`;
      const keyId = (await createPartnerWithKey(tx, { orgId, slug: "tagr-" + sfx, name: "tagr", token: "toktagr" + sfx })).keyId;
      const brand = await one<{ id: number }>(sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${"tagr-" + sfx}, 'Acme') RETURNING id`);
      const SHORT = "https://ex.co/abc";
      const STOP = "Reply STOP to opt out";

      const mkCampaign = async (n: string, priority: number, creativeText: string) => {
        const id = (await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, type, link_mode, brand_id)
          VALUES (${orgId}, ${"tagr-" + sfx + "-" + n}, ${"TAGR " + n}, 'active', 'drip', 'manual', ${brand.id}) RETURNING id`)).id;
        await tx.execute(sql`
          INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, priority) VALUES (${id}, ${orgId}, ${tag}, ${priority})`);
        const cre = await one<{ id: number }>(sql`INSERT INTO creatives (slug, org_id, text, status) VALUES (${"tagr-c-" + sfx + n}, ${orgId}, ${creativeText}, 'active') RETURNING id`);
        const st = await one<{ id: number }>(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, creative_id, short_url, stop_text, drip_active)
          VALUES (${orgId}, ${id}, 1, ${cre.id}, ${SHORT}, ${STOP}, true) RETURNING id`);
        return { id, stageId: st.id };
      };
      const mkLead = async (n: number, firstName: string | undefined) => {
        const contactId = (await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1996" + sfx + n}) RETURNING id`)).id;
        if (firstName !== undefined) {
          await tx.execute(sql`INSERT INTO contact_attributes (contact_id, org_id, first_name) VALUES (${contactId}, ${orgId}, ${firstName})`);
        }
        return (await one<{ id: string }>(sql`
          INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, interest_tag, received_at)
          VALUES (${orgId}, ${contactId}, ${keyId}, 'tagr', ${tag}, now()) RETURNING id`)).id;
      };

      // Pad P1's creative so L = 12 under exactly the inputs routing uses.
      const tmpl = await one<{ template: string | null }>(sql`SELECT template FROM message_formats WHERE org_id = ${orgId}::uuid AND is_default`);
      const shape = shapeFromStage({ message_format_id: null, custom_text: null, format_template: tmpl?.template ?? null });
      const footer = resolveOptOutFooter({ stageStopText: STOP }).text;
      let tagged = "";
      for (let pad = 0; pad < 160; pad++) {
        const t = `Hi {first_name} ${"a".repeat(pad)}`;
        if (firstNameMaxLength({ shape, brandName: "Acme", creativeText: t, linkUrl: SHORT, stopText: footer }, 1) === 12) { tagged = t; break; }
      }
      bar("fixture: P1 creative padded to L = 12", tagged !== "");

      const p1 = await mkCampaign("p1", 1, tagged);
      const p2 = await mkCampaign("p2", 2, "Plain sale today");
      // R5 fixture: a follow-up child of P2 with a tagged creative.
      const childCre = await one<{ id: number }>(sql`INSERT INTO creatives (slug, org_id, text, status) VALUES (${"tagr-ch-" + sfx}, ${orgId}, 'Hey {first_name}, still there?', 'active') RETURNING id`);
      await tx.execute(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, creative_id, short_url, stop_text, drip_active, parent_stage_id, behavioral_tier, drip_followup_minutes)
        VALUES (${orgId}, ${p2.id}, 2, ${childCre.id}, ${SHORT}, ${STOP}, true, ${p2.stageId}, 0, 60)`);

      const noName = await mkLead(1, undefined);
      const longName = await mkLead(2, "Abcdefghijklmno");

      let v = (await evaluateLeadRouting(T, { orgId, leadEventId: noName, tagRules: "load" }))!;
      const c1 = v.candidates.find((c) => c.campaign_id === p1.id)!;
      const c2 = v.candidates.find((c) => c.campaign_id === p2.id)!;
      bar("R1 lead without first_name ⇒ routed to P2", v.winner?.campaign_id === p2.id, `winner ${v.winner?.campaign_id}`);
      bar("R1 P1 carries creative_tags = missing, detail 'missing data: first_name'",
        c1.rules.creative_tags === "missing" && c1.detail.creative_tags === "missing data: first_name", JSON.stringify({ r: c1.rules.creative_tags, d: c1.detail.creative_tags }));
      bar("R3 tag-less P2 has NO creative_tags key", !("creative_tags" in c2.rules) && !("creative_tags" in c2.detail), JSON.stringify(c2.rules));
      bar("R5 P2's tagged follow-up child does not add the rule", !("creative_tags" in c2.rules));

      const v4 = (await evaluateLeadRouting(T, { orgId, leadEventId: longName, tagRules: "load" }))!;
      const c14 = v4.candidates.find((c) => c.campaign_id === p1.id)!;
      bar("R4 15-character name, L = 12 ⇒ blocked, 'segment limit (first_name 15 > 12)'",
        c14.rules.creative_tags === "blocked" && c14.detail.creative_tags === "segment limit (first_name 15 > 12)", JSON.stringify(c14.detail));

      const cache = await loadCampaignTagRules(T, orgId, [p1.id, p2.id]);
      const vc = (await evaluateLeadRouting(T, { orgId, leadEventId: noName, tagRules: cache }))!;
      bar("R6 per-tick cache == load mode", JSON.stringify(vc.candidates.map((c) => [c.campaign_id, c.rules, c.detail])) ===
        JSON.stringify(v.candidates.map((c) => [c.campaign_id, c.rules, c.detail])));

      // Review I2: routing measures with the footer of the numbers that will actually
      // send — the campaign's pool — most restrictive wins.
      const LONG = "Reply STOP to opt out now!"; // 5 chars longer than the stage footer
      const prov = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name) VALUES (${"tagr-p-" + sfx}, ${orgId}, 'tagr') RETURNING id`);
      const ph = await one<{ id: number }>(sql`
        INSERT INTO provider_phones (org_id, provider_id, phone_number, opt_out_footer) VALUES (${orgId}, ${prov.id}, ${"+1995" + sfx}, ${LONG}) RETURNING id`);
      await tx.execute(sql`INSERT INTO drip_campaign_numbers (campaign_id, provider_phone_id, org_id) VALUES (${p1.id}, ${ph.id}, ${orgId})`);
      const longFooter = resolveOptOutFooter({ numberFooter: LONG, stageStopText: STOP }).text;
      const expectL = firstNameMaxLength({ shape, brandName: "Acme", creativeText: tagged, linkUrl: SHORT, stopText: longFooter }, 1);
      const pooled = (await loadCampaignTagRules(T, orgId, [p1.id])).get(p1.id) as { firstNameMaxLength: number | null };
      bar(`R7 routing limit uses the pool number's longer footer (L ${expectL} < 12)`,
        expectL !== null && expectL < 12 && pooled.firstNameMaxLength === expectL, JSON.stringify({ pooled, expectL }));

      // Review M1: a campaign missing from the per-tick cache is loaded, never skipped.
      const vMiss = (await evaluateLeadRouting(T, { orgId, leadEventId: noName, tagRules: new Map() }))!;
      bar("R8 cache miss ⇒ rule still evaluated (fail-closed)", vMiss.candidates.find((c) => c.campaign_id === p1.id)?.rules.creative_tags === "missing");

      await tx.execute(sql`UPDATE campaigns SET status = 'archived' WHERE id = ${p2.id}`);
      v = (await evaluateLeadRouting(T, { orgId, leadEventId: noName, tagRules: "load" }))!;
      const own = v.candidates.filter((c) => c.campaign_id === p1.id);
      bar("R2 only P1 left ⇒ no winner, outcome permanent", v.winner === null && own.length === 1 && classifyRoutingOutcome({
        ...v, candidates: own,
      }) === "permanent", `winner ${v.winner?.campaign_id}`);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
