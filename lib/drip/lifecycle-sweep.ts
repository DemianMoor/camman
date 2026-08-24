import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  closeCompletedJourneys,
  closeJourneysOnPurchase,
  expireJourneysPastEndDate,
} from "./lifecycle";
import { isDripPostureOn } from "./in-use";

// The lifecycle sweeper (Drip Phase 6).
//
// Three of the five terminal transitions cannot be event-driven, because nothing
// calls us when they become true:
//   • converted — Keitaro's poller writes sale_status; it knows nothing of drip
//   • completed — becomes true when the LAST follow-up sends
//   • expired   — becomes true when a clock passes end_at
//
// Opt-out and archive ARE event-driven and are closed at their source, in the
// same transaction as the thing that caused them. Sweeping is the fallback for
// facts that simply become true, not a second path for the two that don't.
//
// ⚠️ ORDER MATTERS. Purchase runs FIRST: a lead who bought and whose follow-ups
// also finished should read 'converted', not 'completed'. Closing is guarded by
// state IN ('routed','active'), so whichever runs first wins and the later ones
// are no-ops on that row — the order here IS the precedence.

export interface SweepResult {
  campaigns: number;
  converted: number;
  completed: number;
  expired: number;
}

export async function sweepJourneyLifecycle(): Promise<SweepResult> {
  const res: SweepResult = { campaigns: 0, converted: 0, completed: 0, expired: 0 };

  const orgs = (await db.execute(sql`
    SELECT DISTINCT org_id FROM drip_journeys WHERE state IN ('routed', 'active')
  `)) as unknown as { org_id: string }[];

  for (const { org_id: orgId } of orgs) {
    // Posture off ⇒ leave every journey exactly as it is. A sweeper that closed
    // journeys while drip was switched off would mutate state nobody could see
    // the cause of.
    if (!(await isDripPostureOn(orgId))) continue;

    const camps = (await db.execute(sql`
      SELECT DISTINCT campaign_id FROM drip_journeys
      WHERE org_id = ${orgId}::uuid AND state IN ('routed', 'active')
        AND campaign_id IS NOT NULL
    `)) as unknown as { campaign_id: number }[];

    for (const { campaign_id: campaignId } of camps) {
      res.campaigns++;
      res.converted += (await closeJourneysOnPurchase(db, { orgId, campaignId })).closed;
      res.completed += (await closeCompletedJourneys(db, { orgId, campaignId })).closed;
      res.expired += (await expireJourneysPastEndDate(db, { orgId, campaignId })).closed;
    }
  }
  return res;
}
