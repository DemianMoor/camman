import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Re-branding a campaign (Drip Phase 1, item 1b ruling).
//
// A campaign's brand MAY change. What it must not do is silently leave the
// campaign's stages pointing at the OLD brand's assets. Two things can be
// stale afterwards, and they behave differently:
//
//   • THE SENDING NUMBER — cannot self-correct. `provider_phone_id` is a
//     deliberate per-stage choice, so a rebrand strands it on the old brand's
//     number. This BLOCKS approval/activation of the affected stages until the
//     number is changed (write-time guard, never send-time).
//
//   • THE DESTINATION — self-corrects when the stage uses a landing page
//     (landing_page_id), because the URL is constructed at MINT time from the
//     campaign's brand at that moment. Nothing to do. A LEGACY stage carrying a
//     frozen absolute full_url cannot self-correct, so it is WARNED about only.
//
// This is not hypothetical. On 2026-08-22 campaigns 902 (Guide Kin→LumZen) and
// 923 (FitsYou→LumZen) were re-branded in production; 902's five stages kept
// Guide Kin destinations and 923's two kept a FitsYou number. The 1a guard
// allowed it because it grandfathers by "the (brand, number) pair is not
// changing", which is correct for the campaign row and silent about its stages.
// This module is what closes that gap.

export interface StaleStage {
  stage_id: number;
  stage_number: number | null;
  label: string | null;
  status: string;
  send_approved: boolean;
  provider_phone_id: number | null;
  phone_number: string | null;
  phone_brand_name: string | null;
}

export interface LegacyDestinationStage {
  stage_id: number;
  stage_number: number | null;
  full_url: string | null;
}

export interface BrandChangeImpact {
  /** Stages whose sending number belongs to a different brand than the new one. */
  staleNumberStages: StaleStage[];
  /** Legacy stages with a frozen absolute destination that cannot self-correct. */
  legacyDestinationStages: LegacyDestinationStage[];
}

/**
 * What would be stale if `campaignId` moved to `newBrandId`.
 *
 * Read-only. Called by the campaign PATCH (to warn) and by the approve/activate
 * guard (to block). Both use the SAME query so the warning can never disagree
 * with what the block actually enforces.
 *
 * A stage with NO number is not stale — there is nothing to mismatch. A number
 * with NO brand is shared and matches any brand, the same "absent = allowed"
 * reading the per-number carrier policy and the 1a guard use.
 */
export async function computeBrandChangeImpact(
  dbc: DbOrTx,
  { orgId, campaignId, newBrandId }: { orgId: string; campaignId: number; newBrandId: number | null },
): Promise<BrandChangeImpact> {
  if (newBrandId == null) {
    // No brand to match against; nothing can be stale.
    return { staleNumberStages: [], legacyDestinationStages: [] };
  }

  const staleNumberStages = (await dbc.execute(sql`
    SELECT s.id AS stage_id, s.stage_number, s.label, s.status, s.send_approved,
           s.provider_phone_id, pp.phone_number, b.name AS phone_brand_name
    FROM campaign_stages s
    JOIN provider_phones pp ON pp.id = s.provider_phone_id
    LEFT JOIN brands b ON b.id = pp.brand_id
    WHERE s.campaign_id = ${campaignId} AND s.org_id = ${orgId}::uuid
      AND s.archived_at IS NULL
      AND pp.brand_id IS NOT NULL
      AND pp.brand_id <> ${newBrandId}
    ORDER BY s.stage_number, s.id
  `)) as unknown as StaleStage[];

  // Legacy = no landing page, so the destination is a frozen absolute URL that
  // mint-time construction cannot fix.
  const legacyDestinationStages = (await dbc.execute(sql`
    SELECT s.id AS stage_id, s.stage_number, s.full_url
    FROM campaign_stages s
    WHERE s.campaign_id = ${campaignId} AND s.org_id = ${orgId}::uuid
      AND s.archived_at IS NULL
      AND s.landing_page_id IS NULL
      AND s.full_url IS NOT NULL AND s.full_url <> ''
    ORDER BY s.stage_number, s.id
  `)) as unknown as LegacyDestinationStage[];

  return { staleNumberStages, legacyDestinationStages };
}

/**
 * Is THIS stage blocked from approval/activation because its number belongs to a
 * different brand than its campaign?
 *
 * ⚠️ WRITE-TIME ONLY, NEVER SEND-TIME. A stage that is already approved and has
 * materialized rows keeps sending — blocking at dispatch would strand real
 * messages, which is the same rule 1a follows. This gate stops a stale stage
 * being approved or activated, nothing more.
 */
export async function isStageNumberBrandStale(
  dbc: DbOrTx,
  { orgId, stageId }: { orgId: string; stageId: number },
): Promise<{ stale: boolean; message: string | null }> {
  const rows = (await dbc.execute(sql`
    SELECT pp.phone_number, pb.name AS phone_brand, cb.name AS campaign_brand
    FROM campaign_stages s
    JOIN campaigns c        ON c.id = s.campaign_id
    JOIN provider_phones pp ON pp.id = s.provider_phone_id
    LEFT JOIN brands pb ON pb.id = pp.brand_id
    LEFT JOIN brands cb ON cb.id = c.brand_id
    WHERE s.id = ${stageId} AND s.org_id = ${orgId}::uuid
      AND c.brand_id IS NOT NULL
      AND pp.brand_id IS NOT NULL
      AND pp.brand_id <> c.brand_id
    LIMIT 1
  `)) as unknown as { phone_number: string; phone_brand: string | null; campaign_brand: string | null }[];

  const r = rows[0];
  if (!r) return { stale: false, message: null };
  return {
    stale: true,
    message:
      `This stage sends from ${r.phone_number}, registered to ${r.phone_brand ?? "another brand"}, ` +
      `but the campaign's brand is now ${r.campaign_brand ?? "different"}. ` +
      `Choose a number registered to ${r.campaign_brand ?? "this campaign's brand"} before approving it.`,
  };
}
