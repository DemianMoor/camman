// Behavioral-split LANE PICKER test (2026-09-06). Exercises the `tiers` option on
// performBehavioralSplit() — which lanes a split actually creates.
//
// WHY THIS EXISTS. A split used to always stamp three lanes, and the operator
// deleted the tier-0 ("Ignored") lane by hand every time — 73 of the first 77
// groups have only two lanes. On 2026-09-05 that manual delete was skipped on
// three campaigns. The leftover lane was never scheduled and never approved, so
// Phase A could never select it, so it could never materialize, so its group
// could never settle — and the all-or-nothing release gate froze the two lanes
// that WERE scheduled. 650 built messages sat undelivered for ~13h while the
// drain was healthy. Creating only the lanes the operator asked for removes the
// trap; case 6 below is the regression guard.
//
// TEST-DATA SAFETY: every row is seeded under a throwaway organization carrying
// the marker below. Teardown is scoped to that org_id ONLY (asserted to match
// the marker first). Real-data table counts are captured before seeding and
// re-checked after teardown.
//
// Run: npx tsx scripts/test-behavioral-split-lane-picker.ts
import "./_env-preload"; // MUST be first — loads .env.local before db/client init
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  DEFAULT_LANE_TIERS,
  performBehavioralSplit,
  resolveLaneTiers,
} from "@/lib/stages/behavioral-split";
import { settleSplitGroup } from "@/lib/stages/split-group";

const ORG_MARKER = "__BSPLIT_PICKER_TEST__";
const COUNTED_TABLES = [
  "organizations", "campaigns", "campaign_stages", "creatives",
  "campaign_stage_split_groups",
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
  let creativeId = 0;

  async function newCampaign(tag: string): Promise<number> {
    const r = (await db.execute(sql`
      INSERT INTO campaigns (org_id, slug, name, tracking_id)
      VALUES (${orgId}::uuid, ${`picker-${tag}-${unique}`},
              ${`Picker ${tag}`}, ${`picker-${tag}-${unique}`})
      RETURNING id
    `)) as unknown as { id: number }[];
    return r[0].id;
  }
  async function newStage(campaignId: number): Promise<number> {
    const r = (await db.execute(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, creative_id)
      VALUES (${orgId}::uuid, ${campaignId}::int,
              (SELECT coalesce(max(stage_number), 0) + 1
                 FROM campaign_stages WHERE campaign_id = ${campaignId}::int),
              ${creativeId})
      RETURNING id
    `)) as unknown as { id: number }[];
    return r[0].id;
  }
  // Satisfy the SHARED completeness predicate (lib/sends/stage-complete.ts):
  // sent_at set AND no pending/sending rows. Deliberately does not touch `status`.
  async function markComplete(stageId: number) {
    await db.execute(sql`
      UPDATE campaign_stages SET sent_at = now() WHERE id = ${stageId}::int
    `);
  }
  // Lanes of a specific GROUP — never a global "no tier-0 anywhere" count, which
  // would go red the first time someone legitimately ticks the Ignored box.
  async function tiersOfGroup(groupId: string): Promise<number[]> {
    const r = (await db.execute(sql`
      SELECT behavioral_tier FROM campaign_stages
      WHERE split_group_id = ${groupId}::uuid AND org_id = ${orgId}::uuid
      ORDER BY behavioral_tier
    `)) as unknown as { behavioral_tier: number }[];
    return r.map((x) => Number(x.behavioral_tier));
  }
  // A campaign ready to split: one completed stage.
  async function readyCampaign(tag: string): Promise<number> {
    const cid = await newCampaign(tag);
    await markComplete(await newStage(cid));
    return cid;
  }

  const before = await tableCounts();
  console.log("Baseline counts captured.");

  try {
    const orgRows = (await db.execute(sql`
      INSERT INTO organizations (name) VALUES (${`${ORG_MARKER} ${unique}`})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    orgId = orgRows[0].id;

    const crRows = (await db.execute(sql`
      INSERT INTO creatives (org_id, slug, text, status)
      VALUES (${orgId}::uuid, ${`picker-cr-${unique}`}, ${"hello"}, ${"active"})
      RETURNING id
    `)) as unknown as { id: number }[];
    creativeId = crRows[0].id;

    // ── Pure unit checks on the normalizer (no DB) ──────────────────────────
    console.log("\nresolveLaneTiers (pure):");
    const rDefault = resolveLaneTiers(undefined);
    check(
      "omitted ⇒ DEFAULT_LANE_TIERS [1,2]",
      rDefault.ok && JSON.stringify(rDefault.tiers) === JSON.stringify([1, 2]),
      JSON.stringify(rDefault),
    );
    check(
      "DEFAULT_LANE_TIERS does NOT include tier 0",
      !DEFAULT_LANE_TIERS.includes(0),
    );
    const rDup = resolveLaneTiers([2, 1, 1]);
    check(
      "de-duplicates and sorts ascending ([2,1,1] ⇒ [1,2])",
      rDup.ok && JSON.stringify(rDup.tiers) === JSON.stringify([1, 2]),
      JSON.stringify(rDup),
    );
    const rEmpty = resolveLaneTiers([]);
    check(
      "[] ⇒ no_lanes_selected",
      !rEmpty.ok && rEmpty.code === "no_lanes_selected",
      JSON.stringify(rEmpty),
    );
    const rBad = resolveLaneTiers([3]);
    check(
      "[3] (converted — never a lane) ⇒ invalid_lane_tier",
      !rBad.ok && rBad.code === "invalid_lane_tier",
      JSON.stringify(rBad),
    );
    const rBad2 = resolveLaneTiers([1, 7]);
    check(
      "[1,7] ⇒ invalid_lane_tier (one bad value poisons the set)",
      !rBad2.ok && rBad2.code === "invalid_lane_tier",
      JSON.stringify(rBad2),
    );

    // ── CASE 1 — the default creates exactly the two lanes we want ──────────
    console.log("\nCase 1 - default (no tiers) ⇒ 2 lanes, tiers [1,2]:");
    const c1 = await readyCampaign("default");
    const s1 = await performBehavioralSplit({ orgId, campaignId: c1 });
    check("split ok", s1.ok, JSON.stringify(s1));
    if (s1.ok) {
      check("returns 2 lane ids", s1.lane_stage_ids.length === 2, JSON.stringify(s1.lane_stage_ids));
      const t = await tiersOfGroup(s1.split_group_id);
      check("persisted lanes are tiers [1,2]", JSON.stringify(t) === JSON.stringify([1, 2]), JSON.stringify(t));
      check("NO tier-0 lane in this group", !t.includes(0));
    }

    // ── CASE 2 — the explicit trio still works (today's behaviour) ──────────
    console.log("\nCase 2 - tiers [0,1,2] ⇒ 3 lanes (unchanged behaviour):");
    const c2 = await readyCampaign("trio");
    const s2 = await performBehavioralSplit({ orgId, campaignId: c2, tiers: [0, 1, 2] });
    check("split ok", s2.ok, JSON.stringify(s2));
    if (s2.ok) {
      const t = await tiersOfGroup(s2.split_group_id);
      check("persisted lanes are tiers [0,1,2]", JSON.stringify(t) === JSON.stringify([0, 1, 2]), JSON.stringify(t));
    }

    // ── CASE 3 — a single lane is allowed ───────────────────────────────────
    console.log("\nCase 3 - tiers [1] ⇒ exactly 1 lane:");
    const c3 = await readyCampaign("single");
    const s3 = await performBehavioralSplit({ orgId, campaignId: c3, tiers: [1] });
    check("split ok", s3.ok, JSON.stringify(s3));
    if (s3.ok) {
      const t = await tiersOfGroup(s3.split_group_id);
      check("persisted lanes are tier [1]", JSON.stringify(t) === JSON.stringify([1]), JSON.stringify(t));
    }

    // ── CASE 4 — invalid selections refuse AND write nothing ────────────────
    // A rejected split must not leave a group row behind: an orphan group would
    // permanently block the campaign via its own split_already_pending guard.
    console.log("\nCase 4 - invalid selections refuse before writing anything:");
    const c4 = await readyCampaign("invalid");
    const s4a = await performBehavioralSplit({ orgId, campaignId: c4, tiers: [] });
    check("[] refused with 400 no_lanes_selected",
      !s4a.ok && s4a.status === 400 && s4a.code === "no_lanes_selected", JSON.stringify(s4a));
    const s4b = await performBehavioralSplit({ orgId, campaignId: c4, tiers: [3] });
    check("[3] refused with 400 invalid_lane_tier",
      !s4b.ok && s4b.status === 400 && s4b.code === "invalid_lane_tier", JSON.stringify(s4b));
    const orphan = (await db.execute(sql`
      SELECT count(*)::int AS n FROM campaign_stage_split_groups
      WHERE campaign_id = ${c4}::int AND org_id = ${orgId}::uuid
    `)) as unknown as { n: number }[];
    check("ZERO group rows written by the refused splits", Number(orphan[0].n) === 0, `got ${orphan[0].n}`);
    const orphanLanes = (await db.execute(sql`
      SELECT count(*)::int AS n FROM campaign_stages
      WHERE campaign_id = ${c4}::int AND org_id = ${orgId}::uuid
        AND behavioral_tier IS NOT NULL
    `)) as unknown as { n: number }[];
    check("ZERO lane rows written by the refused splits", Number(orphanLanes[0].n) === 0, `got ${orphanLanes[0].n}`);

    // ── CASE 5 — de-dup survives the round trip to the DB ───────────────────
    console.log("\nCase 5 - tiers [2,1,1] ⇒ 2 lanes, ascending:");
    const c5 = await readyCampaign("dedup");
    const s5 = await performBehavioralSplit({ orgId, campaignId: c5, tiers: [2, 1, 1] });
    check("split ok", s5.ok, JSON.stringify(s5));
    if (s5.ok) {
      check("returns 2 lane ids (not 3)", s5.lane_stage_ids.length === 2, JSON.stringify(s5.lane_stage_ids));
      const t = await tiersOfGroup(s5.split_group_id);
      check("persisted lanes are tiers [1,2]", JSON.stringify(t) === JSON.stringify([1, 2]), JSON.stringify(t));
    }

    // ── CASE 6 — REGRESSION GUARD for the 2026-09-05 freeze ─────────────────
    // A default-created 2-lane group must be able to reach 'materialized' with no
    // tier-0 lane present. This is the property that was broken: the group could
    // not settle, so Phase B held both scheduled lanes forever.
    console.log("\nCase 6 - a default 2-lane group can SETTLE (the incident guard):");
    const c6 = await readyCampaign("settle");
    const s6 = await performBehavioralSplit({ orgId, campaignId: c6 });
    check("split ok", s6.ok, JSON.stringify(s6));
    if (s6.ok) {
      const gid = s6.split_group_id;
      // Arm the group the way Phase A does, then mark every lane materialized.
      await db.execute(sql`
        UPDATE campaign_stage_split_groups SET state = 'materializing'
        WHERE id = ${gid}::uuid
      `);
      const settledEarly = await settleSplitGroup(db, gid);
      check("does NOT settle while a lane is unmaterialized", settledEarly === false);

      await db.execute(sql`
        UPDATE campaign_stages SET materialized_at = now()
        WHERE split_group_id = ${gid}::uuid AND org_id = ${orgId}::uuid
      `);
      const settled = await settleSplitGroup(db, gid);
      check("settles once both lanes are materialized", settled === true);
      const st = (await db.execute(sql`
        SELECT state FROM campaign_stage_split_groups WHERE id = ${gid}::uuid
      `)) as unknown as { state: string }[];
      check("group state = 'materialized'", st[0]?.state === "materialized", JSON.stringify(st));
    }
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
        // campaigns cascade to stages/lanes/split groups; then creatives; then org.
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
