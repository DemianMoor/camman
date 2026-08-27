// Behavioral-split endpoint logic test. Exercises performBehavioralSplit() — the
// factored-out core the thin route calls — so the auth session isn't needed and
// everything stays under a dedicated throwaway org.
//
// CAMPAIGN-LEVEL since migration 0174: the split is taken against the campaign,
// gated on >=1 COMPLETED stage, and creates a campaign_stage_split_groups row.
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
  // Make a stage satisfy the SHARED completeness predicate
  // (lib/sends/stage-complete.ts): sent_at set AND no pending/sending rows.
  // Deliberately does NOT touch `status` — the whole point of that predicate is
  // that `status` is the operator's manual record and does not decide this.
  async function markComplete(stageId: number) {
    await db.execute(sql`
      UPDATE campaign_stages SET sent_at = now() WHERE id = ${stageId}::int
    `);
  }
  async function groupOf(campaignId: number) {
    const r = (await db.execute(sql`
      SELECT id::text AS id, state, anchor_stage_id, source_stage_ids, recomputed_at
      FROM campaign_stage_split_groups
      WHERE campaign_id = ${campaignId}::int AND org_id = ${orgId}::uuid
      ORDER BY created_at DESC LIMIT 1
    `)) as unknown as {
      id: string; state: string; anchor_stage_id: number | null;
      source_stage_ids: number[]; recomputed_at: string | null;
    }[];
    return r[0] ?? null;
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

    console.log("\nCase 1a - split with NO completed stages (must be rejected):");
    const r1a = await performBehavioralSplit({ orgId, campaignId });
    check(
      "rejected with conflict / reason=no_completed_stages",
      !r1a.ok && r1a.status === 409 &&
        (r1a.details as { reason?: string })?.reason === "no_completed_stages",
      JSON.stringify(r1a),
    );
    check("no group row created by the refusal", (await groupOf(campaignId)) === null);
    check("no lanes created by the refusal", (await lanesOf(parent.id)).length === 0);

    console.log("\nCase 1b - split a campaign with one completed stage:");
    await markComplete(parent.id);
    const r1 = await performBehavioralSplit({ orgId, campaignId });
    check("returns ok with 3 lane ids", r1.ok && r1.lane_stage_ids.length === 3, JSON.stringify(r1));
    const lanes = await lanesOf(parent.id);
    check("exactly 3 lanes persisted", lanes.length === 3, `got ${lanes.length}`);
    check(
      "tiers are exactly {0,1,2}",
      JSON.stringify(lanes.map((l) => l.behavioral_tier)) === JSON.stringify([0, 1, 2]),
      lanes.map((l) => l.behavioral_tier).join(","),
    );
    check("all lanes anchor on the completed stage", lanes.every((l) => l.parent_stage_id === parent.id));
    check("split_index/split_total NULL on every lane", lanes.every((l) => l.split_index === null && l.split_total === null));
    const tids = lanes.map((l) => l.tracking_id);
    check(
      "tracking IDs present and DISTINCT across lanes",
      tids.every((t) => !!t) && new Set(tids).size === 3,
      tids.join(" | "),
    );

    // The GROUP. source_stage_ids is deliberately EMPTY at creation: it is
    // resolved at RECOMPUTE time (T-minus-15 / Phase A), never frozen here, so a
    // stage that completes in between is still included. Asserting empty is
    // asserting that contract, not asserting today's inertness.
    const g1 = await groupOf(campaignId);
    check("a split group row was created", g1 !== null);
    check("group starts state='pending'", g1?.state === "pending", g1?.state);
    check(
      "group source_stage_ids is EMPTY at creation (resolved later)",
      Array.isArray(g1?.source_stage_ids) && g1.source_stage_ids.length === 0,
      JSON.stringify(g1?.source_stage_ids),
    );
    check("group recomputed_at is NULL at creation", g1?.recomputed_at == null);
    check("group anchor = the latest completed stage", Number(g1?.anchor_stage_id) === parent.id);
    const lanesLinked = (await db.execute(sql`
      SELECT count(*)::int AS n FROM campaign_stages
      WHERE split_group_id = ${g1.id}::uuid
    `)) as unknown as { n: number }[];
    check("all 3 lanes carry split_group_id", Number(lanesLinked[0].n) === 3, `got ${lanesLinked[0].n}`);

    console.log("\nCase 2 - re-split while one is still pending (must be rejected):");
    const r2 = await performBehavioralSplit({ orgId, campaignId });
    check(
      "rejected with conflict / reason=split_already_pending",
      !r2.ok && r2.status === 409 &&
        (r2.details as { reason?: string })?.reason === "split_already_pending",
      JSON.stringify(r2),
    );
    check("still exactly 3 lanes (nothing stacked)", (await lanesOf(parent.id)).length === 3);

    console.log("\nCase 2b - re-split after archiving the lanes:");
    await db.execute(sql`
      UPDATE campaign_stages SET status = 'archived'
      WHERE split_group_id = ${g1.id}::uuid
    `);
    const r2b = await performBehavioralSplit({ orgId, campaignId });
    check("re-split ALLOWED once lanes are archived", r2b.ok, JSON.stringify(r2b));
    const liveLanes = (await db.execute(sql`
      SELECT count(*)::int AS n FROM campaign_stages
      WHERE parent_stage_id = ${parent.id}::int AND org_id = ${orgId}::uuid
        AND status <> 'archived'
    `)) as unknown as { n: number }[];
    check("exactly 3 LIVE lanes after re-split", Number(liveLanes[0].n) === 3, `got ${liveLanes[0].n}`);
    await db.execute(sql`
      UPDATE campaign_stages SET status = 'archived'
      WHERE campaign_id = ${campaignId}::int AND behavioral_tier IS NOT NULL
    `);

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
    // The split now needs a COMPLETED stage. Complete BOTH so the anchor is the
    // decoy (stage_number 2) -- lanes then take stage_numbers 3,4,5 exactly as
    // this case's colliding-tracking-id setup assumes.
    await markComplete(source2.id);
    await markComplete(decoy.id);
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
      await performBehavioralSplit({ orgId, campaignId: campaign2Id });
    } catch {
      threw = true;
    }
    check("the split threw on the tracking_id collision", threw);
    check("rolled back: ZERO lanes under the anchor (no orphans)", (await lanesOf(decoy.id)).length === 0);
    // The GROUP row is inserted in the SAME transaction as the lanes, so a
    // rollback must leave no orphan group either -- otherwise the campaign would
    // be permanently blocked by its own split_already_pending guard.
    check("rolled back: ZERO group rows (no orphan group)", (await groupOf(campaign2Id)) === null);
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
