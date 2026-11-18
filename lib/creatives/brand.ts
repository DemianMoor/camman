import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { brands, campaigns, creatives } from "@/db/schema";

// Creative ↔ brand rules (migration 0240, ClickUp 1amdve2d47v).
//
// A creative belongs to exactly ONE brand and may be PICKED only on a stage of
// a campaign of that brand. The check runs only where a creative is picked or
// changed on a stage (stage POST, stage PATCH when creative_id changes) — never
// at send time, and never on copies of an already-saved stage (stage/campaign
// duplicate, split, behavioural lanes). See docs/07-conventions.md
// "A creative's brand is checked on pick/save, never at send".

/** Does this brand exist in the org? */
export async function brandBelongsToOrg(orgId: string, brandId: number): Promise<boolean> {
  const r = await db
    .select({ id: brands.id })
    .from(brands)
    .where(and(eq(brands.id, brandId), eq(brands.org_id, orgId)))
    .limit(1);
  return r.length > 0;
}

export interface StageCreativeBrandRefusal {
  message: string;
  reason: "campaign_brand_missing" | "creative_brand_mismatch";
}

/**
 * Refusal (or null) for putting `creativeId` on a stage of `campaignId`.
 * Callers have already verified the creative belongs to the org.
 */
export async function checkStageCreativeBrand(opts: {
  orgId: string;
  campaignId: number;
  creativeId: number;
}): Promise<StageCreativeBrandRefusal | null> {
  const [row] = await db
    .select({
      creative_brand_id: creatives.brand_id,
      campaign_brand_id: campaigns.brand_id,
      creative_brand_name: brands.name,
    })
    .from(creatives)
    .innerJoin(campaigns, and(eq(campaigns.id, opts.campaignId), eq(campaigns.org_id, opts.orgId)))
    .leftJoin(brands, eq(brands.id, creatives.brand_id))
    .where(and(eq(creatives.id, opts.creativeId), eq(creatives.org_id, opts.orgId)))
    .limit(1);
  if (!row) return null; // org ownership is the caller's check
  if (row.campaign_brand_id == null) {
    return {
      reason: "campaign_brand_missing",
      message: "Set the campaign's brand before picking a creative.",
    };
  }
  if (row.creative_brand_id !== row.campaign_brand_id) {
    return {
      reason: "creative_brand_mismatch",
      message: `This creative belongs to ${row.creative_brand_name ?? "another brand"}. Use "Copy to brand" to make a copy for this campaign's brand.`,
    };
  }
  return null;
}
