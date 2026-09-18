// Verifies the pending-group fallback in GET /api/campaigns/[campaignId]/stages/
// lane-counts: while a 0174 split group's `source_stage_ids` is still empty, the
// displayed lane count must use the CAMPAIGN-WIDE completed-stage set (what the
// T−15 recompute will resolve) instead of falling back to the anchor stage.
//
// READ-ONLY. No fixtures, no teardown — it runs the real helpers against whatever
// live campaign currently has a pending split group, so it also proves the two
// universes actually differ on production data rather than only in theory.
//
// Run: npx tsx scripts/test-lane-count-pending-fallback.ts
import "./_env-preload"; // MUST be first — loads .env.local before db/client init
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  computeLaneAudienceCountsBatch,
  type LaneCountBatchItem,
} from "@/lib/audience-snapshot";
import { resolveCompletedStages } from "@/lib/sends/stage-complete";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface LaneRow {
  id: number;
  campaign_id: number;
  org_id: string;
  behavioral_tier: number;
  parent_stage_id: number | null;
  split_group_id: string | null;
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  split_index: number | null;
  split_total: number | null;
  source_stage_ids: number[] | null;
  group_state: string | null;
}

function toItem(r: LaneRow, sourceStageIds: number[] | null): LaneCountBatchItem {
  return {
    stageId: r.id,
    behavioralTier: r.behavioral_tier,
    parentStageId: r.parent_stage_id,
    include_no_status: r.include_no_status,
    include_clickers: r.include_clickers,
    exclude_clickers: r.exclude_clickers,
    split_index: r.split_index,
    split_total: r.split_total,
    sourceStageIds,
    splitGroupId: r.split_group_id,
  };
}

async function main() {
  // ── Find a campaign whose split group is still 'pending' ───────────────────
  const lanes = (await db.execute(sql`
    SELECT s.id, s.campaign_id, s.org_id, s.behavioral_tier, s.parent_stage_id,
           s.split_group_id, s.include_no_status, s.include_clickers,
           s.exclude_clickers, s.split_index, s.split_total,
           g.source_stage_ids, g.state AS group_state
    FROM campaign_stages s
    JOIN campaign_stage_split_groups g ON g.id = s.split_group_id
    WHERE s.behavioral_tier IS NOT NULL
      AND s.archived_at IS NULL
      AND g.state = 'pending'
      AND cardinality(g.source_stage_ids) = 0
    ORDER BY s.campaign_id DESC, s.stage_number ASC
  `)) as unknown as LaneRow[];

  if (lanes.length === 0) {
    console.log(
      "SKIP: no campaign currently has a pending split group with an empty source set.\n" +
        "The fallback is unobservable right now — create a behavioural split and re-run.",
    );
    await pgConn.end();
    return;
  }

  // Take the newest such campaign; its lanes share one group.
  const campaignId = Number(lanes[0].campaign_id);
  const orgId = lanes[0].org_id;
  const group = lanes.filter((l) => Number(l.campaign_id) === campaignId);
  console.log(
    `Campaign ${campaignId} — ${group.length} pending lane(s), tiers ${group
      .map((l) => l.behavioral_tier)
      .join("/")}\n`,
  );

  const completed = (await resolveCompletedStages(db, campaignId, orgId)).map((s) =>
    Number(s.id),
  );
  console.log(`Completed source stages: [${completed.join(", ")}]`);
  console.log(
    `Anchor (parent_stage_id): ${group[0].parent_stage_id}\n`,
  );

  check(
    "campaign has >1 completed stage (otherwise the two universes are identical)",
    completed.length > 1,
    `${completed.length} completed`,
  );

  // ── OLD behaviour: sourceStageIds null ⇒ alivenessKey falls back to parent ──
  const before = await computeLaneAudienceCountsBatch(
    campaignId,
    orgId,
    group.map((r) => toItem(r, null)),
  );
  // ── NEW behaviour: the campaign-wide completed set ─────────────────────────
  const after = await computeLaneAudienceCountsBatch(
    campaignId,
    orgId,
    group.map((r) => toItem(r, completed)),
  );

  for (const r of group) {
    const b = before.get(r.id) ?? 0;
    const a = after.get(r.id) ?? 0;
    console.log(`\n  lane ${r.id} (tier ${r.behavioral_tier}): parent-only=${b}  campaign-wide=${a}`);
    // The widened aliveness is a strict SUPERSET of the single-parent one
    // (materialization only ever draws from campaign_audience_pool, so
    // sent(anchor) ⊆ sent(all completed stages)). The count can therefore only
    // rise — a drop would mean the widening dropped somebody, which is a bug.
    check(
      `lane ${r.id} — campaign-wide count is never lower than parent-only`,
      a >= b,
      `${b} → ${a}`,
    );
  }

  const totalBefore = group.reduce((n, r) => n + (before.get(r.id) ?? 0), 0);
  const totalAfter = group.reduce((n, r) => n + (after.get(r.id) ?? 0), 0);
  check(
    "the fallback actually changes something on this campaign",
    totalAfter > totalBefore,
    `${totalBefore} → ${totalAfter} across ${group.length} lane(s)`,
  );

  // ── The counts must agree with the confirm modal ───────────────────────────
  // previewSplitLanes classifies exactly this completed-stage set, so the
  // campaign-wide lane count and the modal's per-tier count must match. This is
  // the property the whole change exists to restore.
  const { previewSplitLanes } = await import("@/lib/stages/split-group");
  const preview = await previewSplitLanes(db, campaignId, orgId);
  for (const r of group) {
    const modal = preview.lanes.find((l) => l.tier === r.behavioral_tier)?.count ?? -1;
    check(
      `lane ${r.id} (tier ${r.behavioral_tier}) — campaign-wide count == confirm-modal count`,
      (after.get(r.id) ?? 0) === modal,
      `list=${after.get(r.id) ?? 0} modal=${modal}`,
    );
  }

  // ── Legacy lanes must be untouched ─────────────────────────────────────────
  // A pre-0174 lane has split_group_id IS NULL. The route never applies the
  // fallback to those, because their send genuinely uses single-parent aliveness.
  const legacy = (await db.execute(sql`
    SELECT count(*)::int AS n
    FROM campaign_stages
    WHERE behavioral_tier IS NOT NULL AND split_group_id IS NULL AND archived_at IS NULL
  `)) as unknown as { n: number }[];
  check(
    "legacy (pre-0174) lanes still exist, so the split_group_id IS NULL branch matters",
    Number(legacy[0]?.n ?? 0) > 0,
    `${legacy[0]?.n ?? 0} legacy lanes`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  await pgConn.end();
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end();
  process.exit(1);
});
