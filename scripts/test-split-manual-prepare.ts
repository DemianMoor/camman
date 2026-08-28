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
import { getSplitGroup } from "@/lib/stages/split-group";

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

    console.log("\nOperator flow: create the split, then click Prepare on a lane");
    const split = await performBehavioralSplit({ orgId, campaignId }, db);
    check("split created", split.ok, JSON.stringify(split));
    if (!split.ok) throw new Error("split failed");

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

    // FAULT INJECTION: a campaign with NO completed stage must still refuse —
    // the fix must not turn the guard into a rubber stamp.
    await db.execute(sql`UPDATE campaign_stages SET sent_at = NULL WHERE id = ${s1}::int`);
    await db.execute(sql`
      UPDATE campaign_stage_split_groups
      SET state = 'pending', source_stage_ids = '{}', recomputed_at = NULL
      WHERE id = ${split.split_group_id}::uuid`);
    const lane2 = split.lane_stage_ids[1];
    await db.execute(sql`
      UPDATE campaign_stages SET scheduled_at = now() + interval '3 days' WHERE id = ${lane2}::int`);
    const k2 = await kickoffStageSend(db, { orgId, campaignId, stageId: lane2 });
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
