// P4 Task 3 (T3.*): the personalization eligibility layers, end to end on the
// preview DB. A stage whose creative is "Hi {first_name} …" (padded so the
// longest name that still fits one segment is L = 12) and 5 contacts:
//   A no contact_attributes row      → missing_tag_data
//   B first_name "N/A"               → missing_tag_data
//   C "Jose"                         → sends
//   D "Abcdefghijklmno" (15 chars)   → segment_limit (15 > 12)
//   E "Mary"                         → sends
// Committed fixture (computeStageEligibilityPreview reads the global db), torn
// down by id in `finally`.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-tag-eligibility.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { computeStageEligibilityPreview } from "@/lib/audience-snapshot";
import { NO_TAG_RULES, firstNameMaxLength, shapeFromStage } from "@/lib/messages/render";
import { buildStageEligibilityExclusions } from "@/lib/sends/eligibility";
import { resolveOptOutFooter } from "@/lib/sends/opt-out-footer";
import { preflightStageSend } from "@/lib/sends/preflight";
import { computeStageReconciliation } from "@/lib/sends/reconcile";
import { enumerateStageRecipients } from "@/lib/sends/recipients";
import { loadStageTagRules } from "@/lib/sends/tag-rules";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const one = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as T[])[0];

async function main() {
  const sfx = Date.now().toString().slice(-8);
  const made = { campaigns: [] as number[], creatives: [] as number[], contacts: [] as string[], brand: 0 };
  try {
    const orgId = (await one<{ id: string }>(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)).id;
    const brand = await one<{ id: number }>(sql`
      INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${"t3b-" + sfx}, ${"Acme"}) RETURNING id`);
    made.brand = brand.id;
    const SHORT = "https://ex.co/abc";
    const STOP = "Reply STOP to opt out";
    const tmpl = await one<{ template: string | null }>(sql`
      SELECT template FROM message_formats WHERE org_id = ${orgId}::uuid AND is_default`);
    // Pad the creative until L = 12 exactly, with the same inputs loadTagRules uses.
    const shape = shapeFromStage({ message_format_id: null, custom_text: null, format_template: tmpl?.template ?? null });
    const footer = resolveOptOutFooter({ stageStopText: STOP }).text;
    let creativeText = "";
    for (let pad = 0; pad < 160; pad++) {
      const t = `Hi {first_name} ${"a".repeat(pad)}`;
      if (firstNameMaxLength({ shape, brandName: "Acme", creativeText: t, linkUrl: SHORT, stopText: footer }, 1) === 12) { creativeText = t; break; }
    }
    bar("fixture: a padding gives L = 12", creativeText !== "");

    const mkCreative = async (text: string) => {
      const c = await one<{ id: number }>(sql`INSERT INTO creatives (slug, org_id, text, status) VALUES (${"t3c-" + sfx + made.creatives.length}, ${orgId}, ${text}, 'active') RETURNING id`);
      made.creatives.push(c.id);
      return c.id;
    };
    const mkStage = async (creativeId: number) => {
      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id)
        VALUES (${orgId}, ${"t3-" + sfx + made.campaigns.length}, 't3', 'active', 'manual', ${brand.id}) RETURNING id`);
      made.campaigns.push(camp.id);
      const st = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, creative_id, short_url, stop_text, include_no_status, include_clickers, exclude_clickers, send_approved)
        VALUES (${orgId}, ${camp.id}, 1, ${creativeId}, ${SHORT}, ${STOP}, true, false, false, true) RETURNING id`);
      return { campaignId: camp.id, stageId: st.id };
    };
    const names: (string | null | undefined)[] = [undefined, "N/A", "Jose", "Abcdefghijklmno", "Mary"];
    const phones: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const phone = `+1907${sfx.slice(-6)}${i}`;
      const c = await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${phone}) RETURNING id`);
      made.contacts.push(c.id);
      phones.push(phone);
      if (names[i] !== undefined) {
        await db.execute(sql`INSERT INTO contact_attributes (contact_id, org_id, first_name) VALUES (${c.id}, ${orgId}, ${names[i]})`);
      }
    }
    const addPool = async (campaignId: number) => {
      for (const id of made.contacts) {
        await db.execute(sql`
          INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot, was_opt_in_at_snapshot)
          VALUES (${orgId}, ${campaignId}, ${id}, true, false, false)`);
      }
    };

    const tagged = await mkStage(await mkCreative(creativeText));
    await addPool(tagged.campaignId);
    const filters = { includeNoStatus: true, includeClickers: false, excludeClickers: false, splitIndex: null, splitTotal: null };

    console.log("T3 — tagged stage");
    const rules = await loadStageTagRules(db, { orgId, stageId: tagged.stageId });
    bar("T3.1 loadStageTagRules ⇒ { required: [first_name], firstNameMaxLength: 12 }",
      JSON.stringify(rules) === JSON.stringify({ required: ["first_name"], firstNameMaxLength: 12 }), JSON.stringify(rules));

    const pf = await preflightStageSend(db, { orgId, campaignId: tagged.campaignId, stageId: tagged.stageId });
    bar("T3.2 preflight: missing_tag_data = 2, segment_limit = 1", pf.excluded_lifecycle.missing_tag_data === 2 && pf.excluded_lifecycle.segment_limit === 1, JSON.stringify(pf.excluded_lifecycle));
    bar("T3.3 preflight: missing_by_tag.first_name = 2", pf.missing_by_tag.first_name === 2, JSON.stringify(pf.missing_by_tag));
    bar("T3.4 preflight: recipient_count = 2", pf.recipient_count === 2, String(pf.recipient_count));
    const others = Object.entries(pf.excluded_lifecycle).filter(([k, v]) => k !== "missing_tag_data" && k !== "segment_limit" && v !== 0);
    bar("T3.5 every other bucket is 0 (unchanged)", others.length === 0, JSON.stringify(others));

    const recips = await enumerateStageRecipients(db, {
      campaignId: tagged.campaignId, orgId, filters,
      eligibility: { creativeId: null, offerId: null, excludePriorOffer: false, lifecycleRules: false, offerRulesEnabled: false, offerCooldownDays: 7, offerLimitTimes: 5, tagRules: rules as typeof NO_TAG_RULES },
    });
    bar("T3.6 recipients are exactly Jose and Mary", JSON.stringify(recips.map((r) => r.phone_number).sort()) === JSON.stringify([phones[2], phones[4]].sort()), JSON.stringify(recips.map((r) => r.phone_number)));

    const prev = await computeStageEligibilityPreview({
      orgId, campaignId: tagged.campaignId, mode: "active",
      stageFilters: { include_no_status: true, include_clickers: false, exclude_clickers: false },
      eligibility: { currentCreativeId: null, currentOfferId: null, excludePriorOffer: false, offerRulesEnabled: false, offerCooldownDays: 7, offerLimitTimes: 5, lifecycleRules: false, tagRules: rules as typeof NO_TAG_RULES },
    });
    bar("T3.7 stage audience preview: missing_tag_data = 2, segment_limit = 1, will_send = 2",
      prev.excluded_lifecycle.missing_tag_data === 2 && prev.excluded_lifecycle.segment_limit === 1 && prev.will_send === 2, JSON.stringify(prev));

    const rec = await computeStageReconciliation(db, { campaignId: tagged.campaignId, orgId, stageId: tagged.stageId, filters });
    bar("T3.8 reconcile: layers missing_tag_data = 2, segment_limit = 1, qualified = 2",
      rec.excluded_by_layer.missing_tag_data === 2 && rec.excluded_by_layer.segment_limit === 1 && rec.qualified === 2, JSON.stringify({ l: rec.excluded_by_layer, q: rec.qualified }));

    console.log("\nT3 — a tagged stage kickoff would refuse outright shows a blocker (minor #9)");
    const tooLong = await mkStage(await mkCreative(`Hi {first_name} ${"a".repeat(170)}`));
    await addPool(tooLong.campaignId);
    const pfRefused = await preflightStageSend(db, { orgId, campaignId: tooLong.campaignId, stageId: tooLong.stageId });
    bar("T3.12 over 1 segment even with an empty name ⇒ blocker multi_segment_not_allowed, not ok",
      pfRefused.blockers.includes("multi_segment_not_allowed") && pfRefused.ok === false,
      JSON.stringify({ blockers: pfRefused.blockers, ok: pfRefused.ok }));
    bar("T3.13 …and the checklist names it", pfRefused.checks.some((c) => c.key === "personalization" && !c.ok), JSON.stringify(pfRefused.checks.map((c) => c.key)));

    console.log("\nT3 — tag-less stage is untouched");
    const plain = await mkStage(await mkCreative("Hi there, big sale today"));
    await addPool(plain.campaignId);
    const plainRules = await loadStageTagRules(db, { orgId, stageId: plain.stageId });
    bar("T3.9 a tag-less stage gets NO_TAG_RULES", plainRules === NO_TAG_RULES, JSON.stringify(plainRules));
    const layers = buildStageEligibilityExclusions({
      orgId, currentCampaignId: plain.campaignId, currentCreativeId: 1, currentOfferId: 1, excludePriorOffer: true,
      lifecycleRules: true, offerRulesEnabled: true, offerCooldownDays: 7, offerLimitTimes: 5, tagRules: plainRules as typeof NO_TAG_RULES,
    });
    bar("T3.10 …so no personalization layer is built (SQL unchanged)", !layers.some((l) => l.key === "missing_tag_data" || l.key === "segment_limit"), layers.map((l) => l.key).join(","));
    const pf2 = await preflightStageSend(db, { orgId, campaignId: plain.campaignId, stageId: plain.stageId });
    bar("T3.11 tag-less preflight: all 5 recipients, no buckets, missing_by_tag {}",
      pf2.recipient_count === 5 && Object.values(pf2.excluded_lifecycle).every((v) => v === 0) && JSON.stringify(pf2.missing_by_tag) === "{}",
      JSON.stringify({ n: pf2.recipient_count, ex: pf2.excluded_lifecycle, m: pf2.missing_by_tag }));
  } finally {
    for (const id of made.campaigns) await db.execute(sql`DELETE FROM campaigns WHERE id = ${id}`);
    for (const id of made.creatives) await db.execute(sql`DELETE FROM creatives WHERE id = ${id}`);
    for (const id of made.contacts) await db.execute(sql`DELETE FROM contacts WHERE id = ${id}`);
    if (made.brand) await db.execute(sql`DELETE FROM brands WHERE id = ${made.brand}`);
    await pgConn.end({ timeout: 5 });
  }
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
