// One-shot backfill: assign Phase 9 tracking_ids to every existing
// campaign + stage that's eligible (brand + offer set for campaigns;
// parent has tracking_id + stage has creative_id for stages). Idempotent
// — only writes rows where tracking_id IS NULL, so re-running after a
// partial run picks up where it left off.
//
// Run: `npx tsx scripts/backfill-tracking-ids.ts` against the same
// DATABASE_URL the deployed app uses. Migrations 0038 must be applied
// first. Bypasses RLS via the privileged DB connection — does NOT
// require a signed-in user.
//
// Process order: campaigns by (org_id ASC, created_at ASC, id ASC) so
// the counter table fills sequentially and ties break deterministically.
// Then stages by (campaign_id ASC, stage_number ASC). Status is ignored
// — archived campaigns/stages still get IDs since they may appear in
// historical analytics URLs.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { and, asc, eq, isNull, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { campaign_stages, campaigns } from "@/db/schema";
import {
  generateCampaignTrackingId,
  generateStageTrackingId,
} from "@/lib/tracking-id";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set in .env.local");
    process.exit(1);
  }

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  let campaignsFilled = 0;
  let campaignsSkipped = 0;
  let stagesFilled = 0;
  let stagesSkipped = 0;
  const skipReasons: Record<string, number> = {};
  function note(reason: string) {
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
  }

  try {
    // ============ Campaigns ============
    const campaignRows = await db
      .select({
        id: campaigns.id,
        org_id: campaigns.org_id,
        brand_id: campaigns.brand_id,
        offer_id: campaigns.offer_id,
        created_at: campaigns.created_at,
      })
      .from(campaigns)
      .where(isNull(campaigns.tracking_id))
      .orderBy(
        asc(campaigns.org_id),
        asc(campaigns.created_at),
        asc(campaigns.id),
      );

    console.log(
      `Found ${campaignRows.length} campaigns without tracking_id.`,
    );

    for (const c of campaignRows) {
      if (c.brand_id == null || c.offer_id == null) {
        campaignsSkipped++;
        note("campaign: brand or offer missing");
        continue;
      }
      // Each campaign + its counter allocation in its own transaction so
      // a failure on one campaign doesn't take the whole backfill down.
      try {
        await db.transaction(async (tx) => {
          const trackingId = await generateCampaignTrackingId(tx, {
            orgId: c.org_id,
            brandId: c.brand_id as number,
            offerId: c.offer_id as number,
            createdAt: c.created_at,
          });
          await tx
            .update(campaigns)
            .set({ tracking_id: trackingId })
            .where(eq(campaigns.id, c.id));
        });
        campaignsFilled++;
      } catch (err) {
        campaignsSkipped++;
        note(`campaign: ${(err as Error).message}`);
      }
    }

    // ============ Stages ============
    // Stages whose parent has tracking_id (any campaign) AND whose own
    // tracking_id is NULL. We join in SQL so we don't pull stages
    // belonging to still-NULL parent campaigns (those will get filled in
    // a future run once their parent is resolved).
    const stageRows = await db
      .select({
        id: campaign_stages.id,
        stage_number: campaign_stages.stage_number,
        creative_id: campaign_stages.creative_id,
        campaign_tracking_id: campaigns.tracking_id,
      })
      .from(campaign_stages)
      .innerJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
      .where(
        and(
          isNull(campaign_stages.tracking_id),
          drizzleSql`${campaigns.tracking_id} IS NOT NULL`,
        ),
      )
      .orderBy(
        asc(campaign_stages.campaign_id),
        asc(campaign_stages.stage_number),
      );

    console.log(
      `Found ${stageRows.length} stages whose parent has a tracking_id but they don't.`,
    );

    for (const s of stageRows) {
      if (s.creative_id == null) {
        stagesSkipped++;
        note("stage: creative_id missing");
        continue;
      }
      if (s.campaign_tracking_id == null) {
        // Shouldn't happen given the WHERE clause, but be defensive.
        stagesSkipped++;
        note("stage: parent tracking_id missing (unexpected)");
        continue;
      }
      const tracking = generateStageTrackingId({
        campaignTrackingId: s.campaign_tracking_id,
        stageNumber: s.stage_number,
        creativeId: s.creative_id,
      });
      try {
        await db
          .update(campaign_stages)
          .set({ tracking_id: tracking })
          .where(eq(campaign_stages.id, s.id));
        stagesFilled++;
      } catch (err) {
        stagesSkipped++;
        note(`stage: ${(err as Error).message}`);
      }
    }

    console.log("");
    console.log("=== Summary ===");
    console.log(`Campaigns: filled=${campaignsFilled}, skipped=${campaignsSkipped}`);
    console.log(`Stages:    filled=${stagesFilled}, skipped=${stagesSkipped}`);
    if (Object.keys(skipReasons).length > 0) {
      console.log("Skip reasons:");
      for (const [reason, count] of Object.entries(skipReasons)) {
        console.log(`  ${count}x ${reason}`);
      }
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
