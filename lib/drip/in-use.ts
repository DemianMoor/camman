import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";

// The drip half of the "contacts in use" definition (Drip Phase 4, ruling G2).
//
// ⭐ WHY THIS FILE EXISTS AT ALL. There are TWO independent in-use definitions
// in the codebase and they must not drift:
//
//   1. `iu_set` in lib/audience-snapshot.ts  — the CAMPAIGN-level flag
//      (campaigns.exclude_in_use_contacts)
//   2. `applyInUseExclusion` in lib/segment-rules-eval.ts — the SEGMENT-level
//      flag (segments.exclude_in_use_contacts)
//
// Before drip they agreed by coincidence: both read campaign_audience_pool for
// active campaigns. Adding drip journeys to only one would make the campaign
// flag see drip while the segment flag did not — two answers to "is this contact
// in use?" from one product. Both now call the ONE builder below.
//
// ⭐ AND WHY IT IS CONDITIONAL RATHER THAN ALWAYS-EMITTED-EMPTY.
// R14 requires that regular-campaign activation be UNCHANGED. Measured on
// production, always UNION-ing an empty drip branch preserves the original
// subplan exactly but adds an outer dedup pass:
//
//     baseline            HashAggregate (cost=9959.01..10720.87)
//     always-UNION empty  HashAggregate (cost=11292.28..12054.15)   ← +13%
//
// A 13% cost increase that someone has to re-justify at every future review is
// not "unchanged". So the branch is emitted ONLY when drip posture is on for the
// org. With posture off — which is every org today — these builders return
// exactly what they returned before, character for character, and the plan is
// identical BY CONSTRUCTION rather than by measurement. That is what R14 asks
// for, and scripts/test-drip-in-use-sql-shape.ts pins both shapes.

/** Live journey states — a contact in one of these is "in use" by drip. */
export const LIVE_JOURNEY_STATES = ["routed", "active"] as const;

/**
 * Is drip switched on for this org?
 *
 * Posture, not capability and not the latch (ruling G9). Reads false on any
 * failure: an unreadable flag must never be able to turn drip semantics ON,
 * the same fail-toward-existing-behaviour direction R13 mandates for the
 * opt-out breaker.
 */
export async function isDripPostureOn(orgId: string): Promise<boolean> {
  try {
    const rows = (await db.execute(sql`
      SELECT drip_enabled FROM org_settings WHERE org_id = ${orgId}::uuid LIMIT 1
    `)) as unknown as { drip_enabled: boolean }[];
    return rows[0]?.drip_enabled === true;
  } catch (err) {
    console.error("[drip/in-use] posture read failed, treating drip as OFF:", err);
    return false;
  }
}

/**
 * The drip contribution to the in-use set, or `null` when drip is off.
 *
 * `null` — not an empty SQL fragment — is deliberate: it forces the caller to
 * decide between "emit nothing at all" and "emit a UNION", rather than silently
 * splicing in an empty branch and paying for the extra dedup pass.
 */
export function dripInUseSubquery(orgId: string, postureOn: boolean): SQL | null {
  if (!postureOn) return null;
  return sql`
      select distinct j.contact_id
      from drip_journeys j
      where j.org_id = ${orgId}::uuid
        and j.state in ('routed', 'active')`;
}

/**
 * The `iu_set` CTE body, with the drip branch spliced in only when posture is on.
 *
 * ⚠️ The `postureOn === false` return value must stay BYTE-IDENTICAL to the
 * literal that lived in flagSetCtes before Phase 4. The shape test compares it
 * against a frozen copy of that string, so an innocent-looking reformat here
 * fails loudly instead of quietly changing every regular campaign's plan.
 */
export function inUseSetBody(orgId: string, postureOn: boolean): SQL {
  const regular = sql`
      select distinct p.contact_id
      from campaign_audience_pool p
      join campaigns ca on ca.id = p.campaign_id
      where p.org_id = ${orgId}::uuid and ca.status = 'active'`;

  const drip = dripInUseSubquery(orgId, postureOn);
  if (!drip) return regular;
  return sql`${regular}
      union
      ${drip}`;
}
