// Behavioral-split endpoint logic test (build step 4). Exercises
// performBehavioralSplit() — the factored-out core the thin route calls — so the
// auth session isn't needed and everything stays under a dedicated throwaway org.
//
// TEST-DATA SAFETY: every row is seeded under a throwaway organization carrying
// the marker below. Teardown is scoped to that org_id ONLY (asserted to match
// the marker first) — never a broad name/slug prefix. Real-data table counts are
// captured before seeding and re-checked after teardown.
//
// Run: npx tsx scripts/test-behavioral-split.ts
import "./_env-preload"; // MUST be first — loads .env.local before db/client init
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  performBehavioralSplit,
  LANE_TIERS,
} from "@/lib/stages/behavioral-split";
import { generateStageTrackingId } from "@/lib/tracking-id";

const ORG_MARKER = "__BSPLIT_TEST__";
const COUNTED_TABLES = [
  "organizations", "campaigns", "campaign_stages", "creatives",
] as const;

async function main() {
  let passed = 0;
  let failed = 0;
  function check(name: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      passed++;
    } else {
      console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
      failed++;
    }
  }

  async function tableCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of COUNTED_TABLES) {
      const r = (await db.execute(
        sql`SELECT count(*)::int AS n FROM ${sql.raw(t)}`,
      )) as unknown as { n: number }[];
      out[t] = Number(r[0]?.n ?? -1);
    }
    return out;
  }

  const unique = Date.now();
  let orgId = "";

  async function newStage(
    campaignId: number,
    creativeId: number | null,
  ): Promise<{ id: number; stage_number: number }> {
    const r = (await db.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, creative_id)
      VALUES (${orgId}::uuid, ${campaignId}::int,
              (SELECT coalesce(max(stage_number), 0) + 1
                 FROM campaign_stages WHERE campaign_id = ${campaignId}::int),
              ${creativeId})
      RETURNING id, stage_number
    `)) as unknown as { id: number; stage_number: number }[];
    return r[0];
  }
  async function lanesOf(parentId: number) {
    return (await db.execute(sql`
      SELECT id, behavioral_tier, parent_stage_id, split_index, split_total, tracking_id
      FROM campaign_stages
      WHERE parent_stage_id = ${parentId}::int AND org_id = ${orgId}::uuid
      ORDER BY behavioral_tier
    `)) as unknown as {
      id: number; behavioral_tier: number; parent_stage_id: number;
      split_index: number | null; split_total: number | null; tracking_id: string | null;
    }[];
  }

  const before = await tableCounts();
  console.log("Baseline counts captured.");

  try {
    // --- Throwaway org + a creative (lanes need it for tracking-id generation). ---
    const orgRows = (await db.execute(sql`
      INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    orgId = orgRows[0].id;

    const crRows = (await db.execute(sql`
      INSERT INTO creatives (org_id, slug, text, status)
      VALUES (${orgId}::uuid, ${`bsplit-cr-${unique}`}, ${"hello"}, ${"active"})
      RETURNING id
    `)) as unknown as { id: number }[];
    const creativeId = crRows[0].id;

    // ====================================================================
    // CASE 1 — split an ordinary stage → exactly 3 lanes (tiers 0/1/2).
    // Campaign carries a tracking_id so lanes generate their own.
    // ====================================================================
    const campRows = (await db.execute(sql`
      INSERT INTO campaigns (org_id, slug, name, tracking_id)
      VALUES (${orgId}::uuid, ${`bsplit-${unique}`}, ${"BSplit Camp"}, ${`bsplit-${unique}`})
      RETURNING id
    `)) as unknown as { id: number }[];
    const campaignId = campRows[0].id;
    const parent = await newStage(campaignId, creativeId);

    console.log("\nCase 1 — split an ordinary stage:");
    const r1 = await performBehavioralSplit({ orgId, campaignId, stageId: parent.id });
    check("returns ok with 3 lane ids", r1.ok && r1.lane_stage_ids.length === 3, JSON.stringify(r1));
    const lanes = await lanesOf(parent.id);
    check("exactly 3 lanes persisted", lanes.length === 3, `got ${lanes.length}`);
    check(
      "tiers are exactly {0,1,2}",
      JSON.stringify(lanes.map((l) => l.behavioral_tier)) === JSON.stringify([0, 1, 2]),
      lanes.map((l) => l.behavioral_tier).join(","),
    );
    check("all lanes parent_stage_id = the chosen stage", lanes.every((l) => l.parent_stage_id === parent.id));
    check("split_index/split_total NULL on every lane", lanes.every((l) => l.split_index === null && l.split_total === null));
    const tids = lanes.map((l) => l.tracking_id);
    check(
      "tracking IDs present and DISTINCT across lanes",
      tids.every((t) => !!t) && new Set(tids).size === 3,
      tids.join(" | "),
    );

    // ====================================================================
    // CASE 2 — splitting a stage that is ITSELF a lane is REJECTED.
    // ====================================================================
    console.log("\nCase 2 — split a lane (should be rejected):");
    const aLaneId = lanes[0].id;
    const r2 = await performBehavioralSplit({ orgId, campaignId, stageId: aLaneId });
    check(
      "rejected with conflict / reason=already_lane",
      !r2.ok && r2.status === 409 &&
        (r2.details as { reason?: string })?.reason === "already_lane",
      JSON.stringify(r2),
    );
    check("no lanes created under the rejected lane", (await lanesOf(aLaneId)).length === 0);

    // ====================================================================
    // CASE 3 — the CHECK constraint from step 1 is active (lanes are coherent,
    // and a half-configured / tier-3 row is rejected at the DB level).
    // ====================================================================
    console.log("\nCase 3 — behavioral_lane CHECK:");
    check("created lanes satisfy CHECK (tier in {0,1,2} AND parent set)", lanes.every((l) => [0, 1, 2].includes(l.behavioral_tier) && l.parent_stage_id != null));
    async function insertRejected(label: string, tier: number | null, parent: number | null) {
      try {
        await db.execute(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, behavioral_tier, parent_stage_id)
          VALUES (${orgId}::uuid, ${campaignId}::int, 9000, ${tier}, ${parent})
        `);
        check(label, false, "insert unexpectedly succeeded");
      } catch {
        check(label, true);
      }
    }
    await insertRejected("CHECK rejects tier set + parent NULL", 1, null);
    await insertRejected("CHECK rejects tier=3 (converted is never a lane)", 3, parent.id);

    // ====================================================================
    // CASE 4 — a failure mid-transaction rolls back cleanly (no orphan lanes).
    // We pre-seed a decoy stage holding the tracking_id the tier-0 lane (stage
    // number 3) will generate, so the lane's tracking_id UPDATE — which runs
    // AFTER the lane rows are inserted — hits the unique index and aborts the tx.
    // ====================================================================
    console.log("\nCase 4 — mid-transaction failure rolls back:");
    const camp2Rows = (await db.execute(sql`
      INSERT INTO campaigns (org_id, slug, name, tracking_id)
      VALUES (${orgId}::uuid, ${`bsplit-r-${unique}`}, ${"BSplit Rollback"}, ${`bsplitr-${unique}`})
      RETURNING id, tracking_id
    `)) as unknown as { id: number; tracking_id: string }[];
    const campaign2Id = camp2Rows[0].id;
    const ct2 = camp2Rows[0].tracking_id;
    const source2 = await newStage(campaign2Id, creativeId); // stage_number 1
    const decoy = await newStage(campaign2Id, creativeId); // stage_number 2
    // Lanes will be stage_numbers 3,4,5 → the tier-0 lane (first new) is sn 3.
    const collidingTid = generateStageTrackingId({
      campaignTrackingId: ct2,
      stageNumber: 3,
      creativeId,
    });
    await db.execute(sql`
      UPDATE campaign_stages SET tracking_id = ${collidingTid}
      WHERE id = ${decoy.id}::int
    `);

    let threw = false;
    try {
      await performBehavioralSplit({ orgId, campaignId: campaign2Id, stageId: source2.id });
    } catch {
      threw = true;
    }
    check("the split threw on the tracking_id collision", threw);
    check("rolled back: ZERO lanes under source2 (no orphans)", (await lanesOf(source2.id)).length === 0);
    check("the decoy stage still exists (only the split tx rolled back)", (
      (await db.execute(sql`SELECT count(*)::int AS n FROM campaign_stages WHERE id = ${decoy.id}::int`)) as unknown as { n: number }[]
    )[0].n === 1);

    // sanity: LANE_TIERS is the 0/1/2 trio (no converted lane)
    check("LANE_TIERS = tiers 0,1,2 (no tier-3 lane)", JSON.stringify(LANE_TIERS.map((t) => t.tier)) === JSON.stringify([0, 1, 2]));
  } finally {
    console.log("\nCleanup (scoped to test org only)");
    try {
      if (orgId) {
        const nameRows = (await db.execute(sql`
          SELECT name FROM organizations WHERE id = ${orgId}::uuid
        `)) as unknown as { name: string }[];
        const name = nameRows[0]?.name ?? "";
        if (!name.startsWith(ORG_MARKER)) {
          throw new Error(`Refusing teardown: org ${orgId} name "${name}" is not the test marker.`);
        }
        // campaigns cascade to all stages/lanes; then creatives; then the org.
        await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM creatives WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
        console.log("  cleanup complete");
      }
    } finally {
      const after = await tableCounts();
      let drift = false;
      for (const t of COUNTED_TABLES) {
        if (before[t] !== after[t]) {
          drift = true;
          console.log(`  \x1b[31mDRIFT\x1b[0m ${t}: before=${before[t]} after=${after[t]}`);
        }
      }
      check("real-data table counts unchanged after teardown", !drift);
      await pgConn.end({ timeout: 5 });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
