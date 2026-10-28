import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { createPartnerWithKey } from "./_partner-fixture";
import { fictionalPhones, refuseIfPhonesInUse } from "./_fictional-phones";
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import {
  combinePreviewParts,
  computeStageAudienceCountForDraft,
  computeStageAudienceCountsBatchForDraft,
  computeStageEligibilityPreview,
  previewAudience,
  previewAudienceAudiencePart,
  previewAudienceBase,
  snapshotAudience,
  type AudiencePreviewInput,
} from "@/lib/audience-snapshot";
import {
  excludeCarrierRejected,
  isCarrierRejectionSuppressionOn,
} from "@/lib/carrier-rejection/eligibility";
import { runEnrichmentBatch } from "@/lib/drip/enrichment";
import { classifyRoutingOutcome, evaluateLeadRouting } from "@/lib/drip/routing-eval";
import { NO_TAG_RULES } from "@/lib/messages/render";
import { buildStageEligibilityExclusions, EXCLUSION_PRIORITY } from "@/lib/sends/eligibility";
import { stageRecipientsSql } from "@/lib/sends/recipients";

// Carrier-rejected numbers — the eligibility filters (PR 2, ClickUp 1amdve2850v), PREVIEW DB.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' D:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-carrier-rejection-eligibility.ts
//
// Four leads arrive through drip intake (so each has a contact, a lead event and
// a partner×tag group). Two of their phones are put in carrier_rejected_phones.
//
//   P1 flag off: excludeCarrierRejected returns the SAME SQL object (byte-identical)
//   P2 flag off: no carrier_rejected layer; on: the layer, first in EXCLUSION_PRIORITY
//   A1 flag off: preview == snapshot == 4
//   A2 ⭐ flag on: preview == snapshot == 2 (the two flagged leads gone)
//   A3 flag on + cap 1: the frozen pool holds no flagged contact
//   A4 lifecycle campaign, flag on: preview == snapshot == 2
//   A5 the two-part preview (base + narrowed audience part) agrees with the whole one
//   A6 draft stage counts (single + batch), flag on: 2
//   M1 materialization off a pool holding all four: 4 off, 2 on
//   M2 stage eligibility preview: will_send 2, carrier_rejected bucket 2
//   D1 drip, toggle OFF: the verdict has no rejected_by_carriers key (reason JSON unchanged)
//   D2 drip, toggle ON: a flagged lead fails rejected_by_carriers and is PERMANENT
//   D3 drip, toggle ON: an unflagged lead passes it
//   S1 isCarrierRejectionSuppressionOn follows org_settings
//
// Own throwaway org; every row is torn down and the residue is counted.

const MARKER = "__CARRIER_REJECTION_ELIGIBILITY_TEST__";
class Rollback extends Error {}
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> => (await db.execute(q)) as unknown as T[];

  const pending = (await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM lead_inbox WHERE status IN ('received','awaiting_lookup')`)).n;
  if (pending > 0) throw new Error(`REFUSING: lead_inbox already has ${pending} claimable row(s)`);

  const phones = fictionalPhones(4);
  const [p0, p1, p2] = phones;
  await refuseIfPhonesInUse(db, phones);
  const flagged = [p1, p2];

  // ── P: pure ────────────────────────────────────────────────────────────────
  console.log("PART P — pure");
  const rel = sql`SELECT 1 AS contact_id`;
  bar("P1 flag off ⇒ excludeCarrierRejected returns the same SQL object", excludeCarrierRejected(rel, "x", false) === rel);
  const layerKeys = (on: boolean) =>
    buildStageEligibilityExclusions({
      orgId: "00000000-0000-0000-0000-000000000000",
      currentCampaignId: 1, currentCreativeId: 1, currentOfferId: 1,
      excludePriorOffer: true, offerRulesEnabled: false, offerCooldownDays: 7, offerLimitTimes: 5,
      lifecycleRules: true, carrierRejectedSuppression: on, tagRules: NO_TAG_RULES,
    }).map((l) => l.key);
  const offKeys = layerKeys(false);
  const onKeys = layerKeys(true);
  bar("P2 off: no carrier_rejected layer; on: the layer, first, everything else unchanged",
    !offKeys.includes("carrier_rejected") && onKeys[0] === "carrier_rejected"
      && onKeys.slice(1).join(",") === offKeys.join(",") && EXCLUSION_PRIORITY[0] === "carrier_rejected",
    `off [${offKeys}] on [${onKeys}]`);

  const sfx = String(Date.now()).slice(-7);
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(
      sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${sfx}`}) RETURNING id`)).id;
    const org = sql`${orgId}::uuid`;
    const { keyId } = await createPartnerWithKey(db, { orgId, slug: "cr-" + sfx, name: "cr", token: "tokcr" + sfx });
    for (const p of phones) {
      await db.execute(sql`
        INSERT INTO phone_lookups (phone, line_type, source, lookup_status, looked_up_at)
        VALUES (${p}, 'mobile', 'manual_edit', 'complete', now())`);
      await db.execute(sql`
        INSERT INTO lead_inbox (org_id, partner_key_id, partner_slug, received_at, raw, phone_e164, interest_tag)
        VALUES (${org}, ${keyId}, ${"cr-" + sfx}, now() - interval '1 minute',
                ${JSON.stringify({ phone: p })}::jsonb, ${p}, 'cr')`);
    }
    await runEnrichmentBatch();
    const contacts = await all<{ id: string; phone_number: string }>(sql`
      SELECT id, phone_number FROM contacts WHERE org_id = ${org}`);
    if (contacts.length !== 4) throw new Error(`intake made ${contacts.length} contacts, want 4`);
    const idOf = Object.fromEntries(contacts.map((c) => [c.phone_number, c.id]));
    const group = (await one<{ id: number }>(sql`
      SELECT id FROM contact_groups WHERE contact_group_id = ${`drip:${orgId}:cr-${sfx}-cr`}`)).id;

    for (const p of flagged) {
      await db.execute(sql`
        INSERT INTO carrier_rejected_phones
          (org_id, phone, hard_count, soft_count, last_rejected_at, last_code, last_provider)
        VALUES (${org}, ${p}, 2, 0, now(), '30005', 'txr')`);
    }

    const net = await one<{ id: number }>(sql`
      INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${org}, ${`n-${sfx}`}, 'n') RETURNING id`);
    const brand = await one<{ id: number }>(sql`
      INSERT INTO brands (org_id, brand_id, name) VALUES (${org}, ${`b-${sfx}`}, 'b') RETURNING id`);
    const offer = await one<{ id: number }>(sql`
      INSERT INTO offers (org_id, offer_id, network_id, name) VALUES (${org}, ${`o-${sfx}`}, ${net.id}, 'o') RETURNING id`);
    const mkCampaign = async (slug: string, status: string) => (await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, offer_id)
      VALUES (${org}, ${`${slug}-${sfx}`}, ${slug}, ${status}, 'manual', ${brand.id}, ${offer.id}) RETURNING id`)).id;
    const draft = await mkCampaign("draft", "draft");

    const legacy = (on: boolean): AudiencePreviewInput => ({
      orgId, lifecycleRules: false, carrierRejectedSuppression: on,
      segmentIds: [], contactGroupIds: [group],
      filters: { include_no_status: true, include_opt_in: true, include_clickers: true, include_not_clicked: true },
      cap: null, excludeInUse: false,
    });
    const lifecycle = (on: boolean): AudiencePreviewInput => ({
      orgId, lifecycleRules: true, carrierRejectedSuppression: on,
      segmentIds: [], contactGroupIds: [group],
      filters: { lifecycle_statuses: ["new"] }, cap: null, excludeInUse: false,
    });
    // Snapshot inside a rolled-back transaction; returns the pool's contacts.
    const snapshot = async (input: AudiencePreviewInput, campaignId: number, keep = false) => {
      let out = { total: 0, pool: [] as string[] };
      const run = async () => db.transaction(async (tx) => {
        const r = await snapshotAudience({ ...input, campaignId }, tx);
        const pool = (await tx.execute(sql`
          SELECT contact_id FROM campaign_audience_pool WHERE campaign_id = ${campaignId}`)) as unknown as { contact_id: string }[];
        out = { total: r.total_matching, pool: pool.map((x) => x.contact_id) };
        if (!keep) throw new Rollback();
      });
      try { await run(); } catch (e) { if (!(e instanceof Rollback)) throw e; }
      return out;
    };
    const flaggedIds = new Set(flagged.map((p) => idOf[p]));

    // ── A: the campaign audience ─────────────────────────────────────────────
    console.log("\nPART A — the campaign audience");
    for (const [label, on, want] of [["A1 flag off", false, 4], ["A2 ⭐ flag on", true, 2]] as const) {
      const p = (await previewAudience(legacy(on))).total_matching;
      const s = (await snapshot(legacy(on), draft)).total;
      bar(`${label}: preview == snapshot == ${want}`, p === want && s === want, `preview ${p}, snapshot ${s}`);
    }
    const capped = await snapshot({ ...legacy(true), cap: 1 }, draft);
    bar("A3 flag on + cap 1: the frozen pool holds no flagged contact",
      capped.pool.length === 1 && !capped.pool.some((c) => flaggedIds.has(c)), `pool ${capped.pool.length}`);
    const lp = await previewAudience(lifecycle(true));
    const ls = await snapshot(lifecycle(true), draft);
    bar("A4 lifecycle campaign, flag on: preview == snapshot == 2",
      lp.total_matching === 2 && ls.total === 2, `preview ${lp.total_matching}, snapshot ${ls.total}`);
    const combined = combinePreviewParts(
      await previewAudienceBase(lifecycle(true)),
      await previewAudienceAudiencePart(lifecycle(true)),
      ["new"],
    );
    bar("A5 two-part preview (base + narrowed audience part) == the whole preview",
      combined.total_matching === lp.total_matching && combined.count === lp.count,
      `parts ${combined.total_matching}, whole ${lp.total_matching}`);
    const draftCampaign = {
      id: draft, orgId, segmentIds: [], excludeSegmentIds: [], contactGroupIds: [group],
      filters: legacy(true).filters, cap: null, excludeInUse: false, lifecycleRules: false,
      carrierRejectedSuppression: true,
    };
    const stageFilters = { include_no_status: true, include_clickers: true, exclude_clickers: false, split_index: null, split_total: null };
    const single = (await computeStageAudienceCountForDraft({ ...draftCampaign, offerId: null }, stageFilters)).count;
    const batch = (await computeStageAudienceCountsBatchForDraft(draftCampaign, [{ stageId: 1, ...stageFilters }])).get(1) ?? 0;
    bar("A6 draft stage counts, flag on: single == batch == 2", single === 2 && batch === 2, `single ${single}, batch ${batch}`);

    // ── M: stage materialization ─────────────────────────────────────────────
    console.log("\nPART M — stage materialization");
    const active = await mkCampaign("active", "active");
    await snapshot(legacy(false), active, true); // a pool frozen BEFORE the toggle: all four
    const recipients = async (on: boolean) => (await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (${stageRecipientsSql({
        campaignId: active, orgId,
        filters: { includeNoStatus: true, includeClickers: true, excludeClickers: false, splitIndex: null, splitTotal: null },
        eligibility: {
          creativeId: null, offerId: offer.id, excludePriorOffer: false, lifecycleRules: false,
          offerRulesEnabled: false, offerCooldownDays: 7, offerLimitTimes: 5, tagRules: NO_TAG_RULES,
          carrierRejectedSuppression: on,
        },
      })}) r`)).n;
    const mOff = await recipients(false);
    const mOn = await recipients(true);
    bar("M1 a pool holding all four materializes 4 with the flag off, 2 with it on", mOff === 4 && mOn === 2, `off ${mOff}, on ${mOn}`);
    const ep = await computeStageEligibilityPreview({
      orgId, campaignId: active, mode: "active", stageFilters,
      eligibility: {
        currentCreativeId: null, currentOfferId: offer.id, excludePriorOffer: false, offerRulesEnabled: false,
        offerCooldownDays: 7, offerLimitTimes: 5, lifecycleRules: false, tagRules: NO_TAG_RULES,
        carrierRejectedSuppression: true,
      },
    });
    bar("M2 stage eligibility preview: will_send 2, reported under carrier_rejected 2",
      ep.will_send === 2 && ep.excluded_lifecycle.carrier_rejected === 2,
      `will_send ${ep.will_send}, carrier_rejected ${ep.excluded_lifecycle.carrier_rejected}`);

    // ── D: drip routing ──────────────────────────────────────────────────────
    console.log("\nPART D — drip routing");
    const setToggle = async (on: boolean) => db.execute(sql`
      INSERT INTO org_settings (org_id, carrier_rejection_suppression_enabled) VALUES (${org}, ${on})
      ON CONFLICT (org_id) DO UPDATE SET carrier_rejection_suppression_enabled = excluded.carrier_rejection_suppression_enabled`);
    const events = await all<{ id: string; contact_id: string }>(sql`
      SELECT id, contact_id FROM lead_events WHERE org_id = ${org}`);
    const ev = (p: string) => events.find((e) => e.contact_id === idOf[p])!.id;
    // As the routing batch does: read the toggle, then evaluate.
    const verdict = async (p: string) => (await evaluateLeadRouting(db, {
      orgId, leadEventId: ev(p), tagRules: "load",
      carrierRejectedSuppression: await isCarrierRejectionSuppressionOn(orgId),
    }))!;

    await setToggle(false);
    const off = await verdict(p1);
    bar("D1 toggle OFF: a flagged lead's verdict has no rejected_by_carriers key",
      !("rejected_by_carriers" in off.global), JSON.stringify(off.global));
    const s1Off = await isCarrierRejectionSuppressionOn(orgId);

    await setToggle(true);
    const on = await verdict(p1);
    bar("D2 toggle ON: a flagged lead fails rejected_by_carriers and is PERMANENT",
      on.global.rejected_by_carriers === "blocked" && classifyRoutingOutcome(on) === "permanent",
      `${on.global.rejected_by_carriers}/${classifyRoutingOutcome(on)}`);
    const clean = await verdict(p0);
    bar("D3 toggle ON: an unflagged lead passes it", clean.global.rejected_by_carriers === "pass",
      String(clean.global.rejected_by_carriers));
    const s1On = await isCarrierRejectionSuppressionOn(orgId);
    bar("S1 isCarrierRejectionSuppressionOn follows org_settings", s1Off === false && s1On === true, `off ${s1Off}, on ${s1On}`);
  } finally {
    if (orgId) {
      const name = (await one<{ name: string } | undefined>(
        sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM lead_events WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_inbox WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_intake_daily WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_intake_hourly WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
    }
    const list = sql.join(phones.map((p) => sql`${p}`), sql`, `);
    await db.execute(sql`DELETE FROM phone_lookups WHERE phone IN (${list}) AND source = 'manual_edit'`);
    await db.execute(sql`DELETE FROM lookup_queue WHERE phone IN (${list})`);
    const left = await one<{ n: string }>(sql`
      SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM contacts WHERE org_id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM carrier_rejected_phones WHERE org_id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM phone_lookups WHERE phone IN (${list}))) AS n`);
    console.log(`\nTeardown: ${left.n} row(s) left`);
    if (Number(left.n) !== 0) fail++;
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
