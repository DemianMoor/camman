// Regression: an operator must be able to PREPARE a behavioural lane by hand,
// straight after creating the split.
//
// The bug: kickoffStageSend refused a grouped lane whose group was still
// 'pending'. A group only leaves 'pending' when the T-15 preflight sweep or
// Phase A resolves it, and BOTH require the lane to be approved and due (or
// inside the lead window). The manual Prepare button satisfies neither, so
// clicking Prepare right after creating a split was a dead end — and the refusal
// copy ("it will prepare itself on the next scheduler tick") was wrong too,
// because with no date set no tick would ever pick it up.
//
// Run: npx tsx --conditions=react-server scripts/test-split-manual-prepare.ts
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { kickoffStageSend } from "@/lib/sends/kickoff";
import { performBehavioralSplit } from "@/lib/stages/behavioral-split";
import {
  getSplitGroup,
  markLaneSkippedEmpty,
} from "@/lib/stages/split-group";

const ORG_MARKER = "__SPLIT_PREPARE_TEST__";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n     ${detail}` : ""}`); failed++; }
}

// One-row typed query. Avoids the ((await ...) as unknown as T[])[0] dance that
// esbuild refuses when the cast wraps onto the next line.
async function one<T>(q: ReturnType<typeof sql>): Promise<T> {
  const rows = (await db.execute(q)) as unknown as T[];
  return rows[0];
}

async function main() {
  const unique = Date.now();
  let orgId = "";
  let fatal: unknown = null;
  try {
    orgId = (await one<{ id: string }>(sql`
      INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`})
      RETURNING id::text AS id`)).id;

    const brandId = (await one<{ id: number }>(sql`
      INSERT INTO brands (org_id, brand_id, name)
      VALUES (${orgId}::uuid, ${`SP-${unique}`}, ${`SplitPrep ${unique}`}) RETURNING id`)).id;
    const creativeId = (await one<{ id: number }>(sql`
      INSERT INTO creatives (org_id, slug, text, status)
      VALUES (${orgId}::uuid, ${`sp-cr-${unique}`}, ${"hi"}, ${"active"}) RETURNING id`)).id;
    const campaignId = (await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, brand_id, link_mode, status, tracking_id)
      VALUES (${orgId}::uuid, ${`sp-${unique}`}, ${"SplitPrep Camp"}, ${brandId}::int,
              ${"manual"}, ${"active"}, ${`sp${unique}`}) RETURNING id`)).id;

    // One COMPLETED stage that actually sent to somebody.
    const s1 = (await one<{ id: number }>(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, creative_id, sent_at, scheduled_at)
      VALUES (${orgId}::uuid, ${campaignId}::int, 1, ${creativeId}::int, now(), now() - interval '1 day')
      RETURNING id`)).id;
    const contactId = (await one<{ id: string }>(sql`
      INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
      VALUES (${orgId}::uuid, ${`+1999${String(unique).slice(-7)}`}, now(), now())
      RETURNING id::text AS id`)).id;
    await db.execute(sql`
      INSERT INTO campaign_audience_pool
        (campaign_id, contact_id, org_id, was_clicker_at_snapshot, was_opt_in_at_snapshot, was_no_status_at_snapshot)
      VALUES (${campaignId}::int, ${contactId}::uuid, ${orgId}::uuid, false, false, true)`);
    await db.execute(sql`
      INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
      VALUES (${orgId}::uuid, ${campaignId}::int, ${s1}::int, ${contactId}::uuid, ${"x"}, ${"body"}, ${"sent"})`);

    // A SECOND contact at tier 2 (reached the offer), so the tier-0 and tier-2
    // lanes both have a recipient. Needed to exercise the settle: a lane with no
    // recipients refuses `no_recipients` on the manual path and never gets far
    // enough to finish its group.
    const contact2 = (await one<{ id: string }>(sql`
      INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
      VALUES (${orgId}::uuid, ${`+1998${String(unique).slice(-7)}`}, now(), now())
      RETURNING id::text AS id`)).id;
    await db.execute(sql`
      INSERT INTO campaign_audience_pool
        (campaign_id, contact_id, org_id, was_clicker_at_snapshot, was_opt_in_at_snapshot, was_no_status_at_snapshot)
      VALUES (${campaignId}::int, ${contact2}::uuid, ${orgId}::uuid, false, false, true)`);
    await db.execute(sql`
      INSERT INTO stage_sends
        (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status,
         offer_reached_at, offer_reach_event_id)
      VALUES (${orgId}::uuid, ${campaignId}::int, ${s1}::int, ${contact2}::uuid,
              ${"y"}, ${"body"}, ${"sent"}, now(), ${`evt-${unique}`})`);

    // A landing page on the source, so we can assert the lane inherits it.
    const networkId = (await one<{ id: number }>(sql`
      INSERT INTO affiliate_networks (org_id, network_id, name)
      VALUES (${orgId}::uuid, ${`SPN-${unique}`}, ${`SplitPrep Net ${unique}`})
      RETURNING id`)).id;
    const offerId = (await one<{ id: number }>(sql`
      INSERT INTO offers (org_id, network_id, offer_id, name)
      VALUES (${orgId}::uuid, ${networkId}::int, ${`SPO-${unique}`}, ${`SplitPrep Offer ${unique}`})
      RETURNING id`)).id;
    const lpId = (await one<{ id: number }>(sql`
      INSERT INTO offer_landing_pages (org_id, offer_id, title, kind, slug, status)
      VALUES (${orgId}::uuid, ${offerId}::int, ${`SplitPrep LP ${unique}`},
              ${"slug"}, ${`sp${unique}`}, ${"active"})
      RETURNING id`)).id;
    await db.execute(sql`
      UPDATE campaign_stages SET landing_page_id = ${lpId}::int WHERE id = ${s1}::int`);

    console.log("\nOperator flow: create the split, then click Prepare on a lane");
    const split = await performBehavioralSplit({ orgId, campaignId }, db);
    check("split created", split.ok, JSON.stringify(split));
    if (!split.ok) throw new Error("split failed");

    // Pre-existing bug from migration 0150, fixed alongside this one: of the four
    // copy paths only stage-duplicate carried landing_page_id, so a fresh lane had
    // NO destination and kickoff refused it with `no_destination`. Observed live on
    // campaign 1062.
    const laneLps = (await db.execute(sql`
      SELECT id, landing_page_id FROM campaign_stages
      WHERE split_group_id = ${split.split_group_id}::uuid ORDER BY stage_number
    `)) as unknown as { id: number; landing_page_id: number | null }[];
    check(
      "every lane INHERITS the source's landing_page_id (else it has no destination)",
      laneLps.length === 3 && laneLps.every((l) => Number(l.landing_page_id) === lpId),
      laneLps.map((l) => `${l.id}:${l.landing_page_id}`).join(" "),
    );

    const before = await getSplitGroup(db, split.split_group_id);
    check("group starts 'pending' with an empty source set (as designed)",
      before?.state === "pending" && (before?.source_stage_ids ?? []).length === 0,
      `state=${before?.state} sources=${JSON.stringify(before?.source_stage_ids)}`);

    // The lane needs a date — the manual Prepare path still refuses no_schedule,
    // which is correct and unrelated. Give it one WITHOUT approving it and
    // WITHOUT making it due, so nothing but the manual path could resolve it.
    const laneId = split.lane_stage_ids[0];
    await db.execute(sql`
      UPDATE campaign_stages SET scheduled_at = now() + interval '3 days'
      WHERE id = ${laneId}::int`);

    // THE REGRESSION: this is exactly what the Prepare button does.
    const k = await kickoffStageSend(db, { orgId, campaignId, stageId: laneId });
    check(
      "manual Prepare is NOT refused as split_group_not_ready",
      !(k.ok === false && k.reason === "split_group_not_ready"),
      JSON.stringify(k),
    );
    check("manual Prepare materialized the lane", k.ok === true, JSON.stringify(k));

    const after = await getSplitGroup(db, split.split_group_id);
    check("Prepare resolved the group itself (pending -> materializing)",
      after?.state === "materializing", after?.state);
    check("the resolved source set contains the completed stage",
      (after?.source_stage_ids ?? []).map(Number).includes(s1),
      JSON.stringify(after?.source_stage_ids));
    check("recomputed_at stamped by the manual path", after?.recomputed_at != null);

    const rows = (await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM stage_sends WHERE stage_id = ${laneId}::int`)).n;
    check("the lane has materialized rows", Number(rows) > 0, `got ${rows}`);

    // A lane finished by the MANUAL path must also finish its GROUP. Phase A
    // settles, but Phase A only ever selects lanes with `materialized_at IS NULL`,
    // so a hand-prepared lane was never followed by a settle from anywhere and its
    // group sat in 'materializing' forever. Phase B gates on 'materialized', so
    // those already-prepared messages would NEVER release — a silent non-send.
    // Found live on campaigns 1032/1033 (2026-08-28), both fully prepared, both
    // stuck, both scheduled to fire that afternoon.
    // The tier-1 lane has nobody — mark it skipped the way Phase A would, so the
    // tier-2 lane below is genuinely the LAST outstanding one.
    await markLaneSkippedEmpty(db, split.lane_stage_ids[1]);
    const midway = await getSplitGroup(db, split.split_group_id);
    check("group is still 'materializing' while a lane is outstanding",
      midway?.state === "materializing", midway?.state);

    const lastLane = split.lane_stage_ids[2];
    await db.execute(sql`
      UPDATE campaign_stages SET scheduled_at = now() + interval '3 days'
      WHERE id = ${lastLane}::int
    `);
    const kLast = await kickoffStageSend(db, { orgId, campaignId, stageId: lastLane });
    check("the last lane prepares by hand", kLast.ok === true, JSON.stringify(kLast));
    const settled = await getSplitGroup(db, split.split_group_id);
    check(
      "the MANUAL path SETTLES the group (materializing -> materialized)",
      settled?.state === "materialized",
      settled?.state,
    );

    // FAULT INJECTION on a SEPARATE campaign — the fix must not turn the guard
    // into a rubber stamp. Its own campaign so the settle work above cannot
    // contaminate it (an earlier version reused this one and the assertion
    // silently passed for the wrong reason).
    const camp2 = (await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, brand_id, link_mode, status, tracking_id)
      VALUES (${orgId}::uuid, ${`sp2-${unique}`}, ${"SplitPrep Camp 2"}, ${brandId}::int,
              ${"manual"}, ${"active"}, ${`sp2${unique}`}) RETURNING id`)).id;
    const c2s1 = (await one<{ id: number }>(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, creative_id, sent_at)
      VALUES (${orgId}::uuid, ${camp2}::int, 1, ${creativeId}::int, now())
      RETURNING id`)).id;
    await db.execute(sql`
      INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
      VALUES (${orgId}::uuid, ${camp2}::int, ${c2s1}::int, ${contactId}::uuid, ${"z"}, ${"body"}, ${"sent"})`);
    const split2 = await performBehavioralSplit({ orgId, campaignId: camp2 }, db);
    if (!split2.ok) throw new Error("second split failed: " + JSON.stringify(split2));
    // Now REMOVE the completed stage, so the group can no longer resolve.
    await db.execute(sql`UPDATE campaign_stages SET sent_at = NULL WHERE id = ${c2s1}::int`);
    const lane2 = split2.lane_stage_ids[0];
    await db.execute(sql`
      UPDATE campaign_stages SET scheduled_at = now() + interval '3 days' WHERE id = ${lane2}::int`);
    const k2 = await kickoffStageSend(db, { orgId, campaignId: camp2, stageId: lane2 });
    check("with NO completed source stage, Prepare still REFUSES",
      k2.ok === false && k2.reason === "split_group_not_ready", JSON.stringify(k2));
  } catch (e) {
    fatal = e;
    console.log("\n  \x1b[31m✗\x1b[0m FATAL — run aborted");
    failed++;
  } finally {
    if (orgId) {
      const nameRows = (await db.execute(sql`
        SELECT name FROM organizations WHERE id = ${orgId}::uuid`)) as unknown as { name: string }[];
      if ((nameRows[0]?.name ?? "").startsWith(ORG_MARKER)) {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
          await tx.execute(sql`DELETE FROM links WHERE org_id = ${orgId}::uuid`);
          await tx.execute(sql`DELETE FROM campaigns WHERE org_id = ${orgId}::uuid`);
          await tx.execute(sql`DELETE FROM offer_landing_pages WHERE org_id = ${orgId}::uuid`);
          await tx.execute(sql`DELETE FROM offers WHERE org_id = ${orgId}::uuid`);
          await tx.execute(sql`DELETE FROM affiliate_networks WHERE org_id = ${orgId}::uuid`);
          await tx.execute(sql`DELETE FROM creatives WHERE org_id = ${orgId}::uuid`);
          await tx.execute(sql`DELETE FROM contacts WHERE org_id = ${orgId}::uuid`);
          await tx.execute(sql`DELETE FROM brands WHERE org_id = ${orgId}::uuid`);
          await tx.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
        });
        const left = (await one<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM organizations WHERE id = ${orgId}::uuid`)).n;
        check("test org fully cleaned up", Number(left) === 0);
      }
    }
    if (fatal) console.error("\nFATAL:\n", fatal);
    console.log(`\n${passed} passed, ${failed} failed`);
    await pgConn.end({ timeout: 5 });
    process.exit(failed > 0 ? 1 : 0);
  }
}
main();
