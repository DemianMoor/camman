import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { TIER_DEFAULT, TIER_LABEL, type FollowupTier } from "./followup-timing";

type DripTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Behavioural follow-up children for a drip first-send stage (Drip Phase 6).
//
// ⚠️ THIS DELIBERATELY ADDS NO NEW CONCEPT. campaign_stages already carries
// parent_stage_id and behavioral_tier, and 536 lane children are live on regular
// campaigns. lib/sends/recipients.ts already selects a lane by
// coalesce(tier,0) = behavioral_tier with an explicit <> 3 guard, so "a buyer
// never appears in a lane" is already enforced upstream of anything here.
// Ignored / Clicked / Offer ARE tiers 0 / 1 / 2. A drip-only children table
// would have duplicated all of that and drifted from it.
//
// What makes a child a DRIP child rather than a regular lane child is exactly
// one thing: drip_followup_minutes is set, so its schedule is relative to each
// contact's own detection moment instead of one absolute scheduled_at.

export const FOLLOWUP_TIERS: FollowupTier[] = [0, 1, 2];

export interface ChildRow {
  id: number;
  parent_stage_id: number;
  behavioral_tier: number;
  drip_followup_minutes: number | null;
  drip_active: boolean | null;
  creative_id: number | null;
  landing_page_id: number | null;
  label: string | null;
}

/**
 * Ensure the three children exist for a drip first-send stage.
 *
 * Idempotent: a child that already exists is left exactly as the operator
 * configured it — this never resets a timer, a creative, or the on/off toggle.
 * It only fills gaps, so it is safe to call on every save.
 *
 * ⚠️ CHILDREN ARE CREATED INACTIVE (drip_active = false). Auto-creating them
 * ACTIVE would mean turning on campaign-level behavioural silently scheduled
 * three extra messages per lead the moment it was ticked. The operator writes
 * the copy and switches each lane on deliberately.
 *
 * ⚠️ landing_page_id and provider/phone INHERIT from the parent (spec: "landing
 * page — default: inherit parent"). Inheriting by COPYING at creation rather
 * than resolving the parent at send time is deliberate: a child whose
 * destination silently changed because someone edited the parent months later
 * would be a surprise, and the child's own picker is what the operator reads.
 */
export async function ensureFollowupChildren(
  tx: DripTx,
  { orgId, parentStageId }: { orgId: string; parentStageId: number },
): Promise<{ created: number; existing: number }> {
  const parent = (await tx.execute(sql`
    SELECT s.id, s.campaign_id, s.org_id, s.creative_id, s.landing_page_id,
           s.sms_provider_id, s.provider_phone_id, s.stop_text, s.drip_active
    FROM campaign_stages s
    WHERE s.id = ${parentStageId} AND s.org_id = ${orgId}::uuid
      AND s.archived_at IS NULL AND s.window_start_min IS NOT NULL
  `)) as unknown as Record<string, unknown>[];
  if (!parent[0]) return { created: 0, existing: 0 };
  const p = parent[0];

  const have = (await tx.execute(sql`
    SELECT behavioral_tier FROM campaign_stages
    WHERE parent_stage_id = ${parentStageId} AND org_id = ${orgId}::uuid
      AND archived_at IS NULL AND drip_followup_minutes IS NOT NULL
  `)) as unknown as { behavioral_tier: number }[];
  const present = new Set(have.map((h) => h.behavioral_tier));

  let created = 0;
  for (const tier of FOLLOWUP_TIERS) {
    if (present.has(tier)) continue;
    await tx.execute(sql`
      INSERT INTO campaign_stages
        (org_id, campaign_id, parent_stage_id, behavioral_tier,
         drip_followup_minutes, drip_active, label,
         creative_id, landing_page_id, sms_provider_id, provider_phone_id, stop_text)
      VALUES (
        ${orgId}::uuid, ${p.campaign_id}, ${parentStageId}, ${tier},
        ${TIER_DEFAULT[tier]}, false, ${TIER_LABEL[tier]},
        NULL, ${p.landing_page_id ?? null}, ${p.sms_provider_id ?? null},
        ${p.provider_phone_id ?? null}, ${p.stop_text ?? "Stop to END"}
      )
    `);
    created++;
  }
  return { created, existing: present.size };
}

/** The children of a parent, tier order, for the editor and the scheduler. */
export async function listFollowupChildren(
  tx: DripTx,
  { orgId, parentStageId }: { orgId: string; parentStageId: number },
): Promise<ChildRow[]> {
  return (await tx.execute(sql`
    SELECT id, parent_stage_id, behavioral_tier, drip_followup_minutes,
           drip_active, creative_id, landing_page_id, label
    FROM campaign_stages
    WHERE parent_stage_id = ${parentStageId} AND org_id = ${orgId}::uuid
      AND archived_at IS NULL AND drip_followup_minutes IS NOT NULL
    ORDER BY behavioral_tier
  `)) as unknown as ChildRow[];
}

/**
 * Sync children for every active first-send stage of a drip campaign, when the
 * campaign has behavioural follow-ups switched on.
 *
 * ⚠️ SWITCHING BEHAVIOURAL OFF DOES NOT DELETE ANYTHING. The spec asks for
 * "toggle on/off without delete", and that has to hold at campaign level too:
 * an operator who turns it off, changes their mind, and turns it back on gets
 * their copy and timers back rather than three blank lanes. Off is enforced at
 * SEND time, not by destroying configuration.
 */
export async function syncCampaignFollowupChildren(
  tx: DripTx,
  { orgId, campaignId }: { orgId: string; campaignId: number },
): Promise<{ parents: number; created: number }> {
  const on = (await tx.execute(sql`
    SELECT 1 FROM drip_campaign_configs
    WHERE campaign_id = ${campaignId} AND org_id = ${orgId}::uuid AND behavioral_enabled
  `)) as unknown as unknown[];
  if (on.length === 0) return { parents: 0, created: 0 };

  const parents = (await tx.execute(sql`
    SELECT id FROM campaign_stages
    WHERE campaign_id = ${campaignId} AND org_id = ${orgId}::uuid
      AND archived_at IS NULL AND window_start_min IS NOT NULL
      AND parent_stage_id IS NULL
    ORDER BY window_start_min
  `)) as unknown as { id: number }[];

  let created = 0;
  for (const p of parents) {
    const r = await ensureFollowupChildren(tx, { orgId, parentStageId: p.id });
    created += r.created;
  }
  return { parents: parents.length, created };
}
