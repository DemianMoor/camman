// Read-only identity + timing proof for computeLaneAudienceCountsBatch.
// For every campaign with visible (non-archived) behavioral-lane stages, compare
// the batched lane counts against the per-lane countStageRecipients path they
// replace, and time both. The batch MUST equal the per-lane numbers stage-for-
// stage — that's the ship gate. Creates no data; only SELECTs.
//
// Run: npx tsx scripts/verify-lane-batch.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as drizzleSql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  computeLaneAudienceCountsBatch,
  type LaneCountBatchItem,
} from "@/lib/audience-snapshot";
import { countStageRecipients } from "@/lib/sends/recipients";

let pass = 0;
let fail = 0;

async function main() {
  // Campaigns that actually render lane rows by default (non-archived lanes).
  const campaigns = (await db.execute(drizzleSql`
    SELECT s.campaign_id, s.org_id::text AS org_id
    FROM campaign_stages s
    WHERE s.behavioral_tier IS NOT NULL AND s.status <> 'archived'
    GROUP BY s.campaign_id, s.org_id
    ORDER BY count(*) DESC, s.campaign_id
    LIMIT 25
  `)) as unknown as { campaign_id: number; org_id: string }[];

  for (const c of campaigns) {
    const cid = Number(c.campaign_id);
    const org = c.org_id;
    const laneRows = (await db.execute(drizzleSql`
      SELECT id, behavioral_tier, parent_stage_id,
             include_no_status, include_clickers, exclude_clickers,
             split_index, split_total
      FROM campaign_stages
      WHERE campaign_id = ${cid} AND org_id = ${org}::uuid
        AND behavioral_tier IS NOT NULL AND status <> 'archived'
      ORDER BY stage_number
    `)) as unknown as {
      id: number;
      behavioral_tier: number;
      parent_stage_id: number | null;
      include_no_status: boolean;
      include_clickers: boolean;
      exclude_clickers: boolean;
      split_index: number | null;
      split_total: number | null;
    }[];
    if (laneRows.length === 0) continue;

    const items: LaneCountBatchItem[] = laneRows.map((r) => ({
      stageId: Number(r.id),
      behavioralTier: Number(r.behavioral_tier),
      parentStageId: r.parent_stage_id == null ? null : Number(r.parent_stage_id),
      include_no_status: r.include_no_status,
      include_clickers: r.include_clickers,
      exclude_clickers: r.exclude_clickers,
      split_index: r.split_index == null ? null : Number(r.split_index),
      split_total: r.split_total == null ? null : Number(r.split_total),
    }));

    // Batch (one query, tier computed once).
    const t0 = process.hrtime.bigint();
    const batch = await computeLaneAudienceCountsBatch(cid, org, items);
    const batchMs = Number(process.hrtime.bigint() - t0) / 1e6;

    // Per-lane baseline (the path being replaced).
    const t1 = process.hrtime.bigint();
    const perLane = new Map<number, number>();
    for (const r of laneRows) {
      const n = await countStageRecipients(db, {
        campaignId: cid,
        orgId: org,
        filters: {
          includeNoStatus: r.include_no_status,
          includeClickers: r.include_clickers,
          excludeClickers: r.exclude_clickers,
          splitIndex: r.split_index,
          splitTotal: r.split_total,
          behavioralTier: r.behavioral_tier,
          parentStageId: r.parent_stage_id,
        },
      });
      perLane.set(Number(r.id), n);
    }
    const perLaneMs = Number(process.hrtime.bigint() - t1) / 1e6;

    let campaignOk = true;
    for (const r of laneRows) {
      const a = batch.get(Number(r.id)) ?? 0;
      const b = perLane.get(Number(r.id)) ?? 0;
      if (a !== b) {
        campaignOk = false;
        console.log(
          `  ❌ campaign ${cid} stage ${r.id}: batch=${a} per-lane=${b}`,
        );
      }
    }
    if (campaignOk) {
      pass++;
      console.log(
        `✅ campaign ${cid} (${laneRows.length} lanes) — batch ${batchMs.toFixed(
          0,
        )}ms vs per-lane ${perLaneMs.toFixed(0)}ms (${(perLaneMs / batchMs).toFixed(1)}× faster)`,
      );
    } else {
      fail++;
    }
  }

  console.log(`\n${pass} campaigns identical, ${fail} mismatched`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
