import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { isDripPostureOn } from "./in-use";
import { evaluateLeadRouting } from "./routing-eval";

// The drip routing worker (Drip Phase 4). ZERO SENDS.
//
// Takes processed leads that have no journey yet, evaluates them against every
// drip campaign, and writes at most ONE journey each. Nothing here can message
// anyone; the scheduler is Phase 5.
//
// ⭐ THE UNIQUE VIOLATION IS A NORMAL OUTCOME, NOT AN ERROR.
// drip_journeys carries a partial unique on (org_id, contact_id) for live
// states. That index — not this code — is what guarantees "exactly one
// campaign". So the insert is optimistic and a 23505 means "another tick, or
// another lead for the same contact in this very batch, got there first":
// skip and move on. Treating it as a failure would turn the invariant working
// correctly into an alert.
//
// ⭐ UNROUTED LEADS GET NO ROW AND ARE RE-EVALUATED. A lead that matches nothing
// today may match tomorrow — a campaign gets created, a cap resets, the contact
// leaves another campaign. Only after DRIP_UNROUTABLE_TTL_DAYS does it become a
// terminal 'unroutable' row carrying its LAST reason, so the debugging tool can
// still say why. The TTL is 7 days, chosen to coincide with the >1-week
// re-entry rule: an unroutable lead becomes re-eligible as a "new" arrival at
// exactly the moment that rule would have re-qualified it anyway, rather than at
// some arbitrary unrelated boundary.

const BATCH_SIZE = 200;
export const DRIP_UNROUTABLE_TTL_DAYS = 7;

export interface RoutingResult {
  postureOn: boolean;
  considered: number;
  routed: number;
  unrouted: number;
  markedUnroutable: number;
  lostRace: number;
  byCampaign: Record<string, number>;
}

export async function runDripRoutingBatch(now: Date = new Date()): Promise<RoutingResult> {
  const res: RoutingResult = {
    postureOn: false, considered: 0, routed: 0, unrouted: 0,
    markedUnroutable: 0, lostRace: 0, byCampaign: {},
  };

  const orgs = (await db.execute(sql`
    SELECT org_id FROM org_settings WHERE drip_enabled = true AND drip_paused = false
  `)) as unknown as { org_id: string }[];
  if (orgs.length === 0) return res;
  res.postureOn = true;

  for (const { org_id: orgId } of orgs) {
    // Belt and braces: the loop above already filtered, but posture is the flag
    // that also gates the in-use SQL shape, so it is read through one helper.
    if (!(await isDripPostureOn(orgId))) continue;

    // Candidates: processed leads with no journey row yet, oldest first.
    const leads = (await db.execute(sql`
      SELECT e.id, e.received_at
      FROM lead_events e
      WHERE e.org_id = ${orgId}::uuid
        AND e.sandbox = false
        AND NOT EXISTS (SELECT 1 FROM drip_journeys j WHERE j.lead_event_id = e.id)
      ORDER BY e.received_at
      LIMIT ${BATCH_SIZE}
    `)) as unknown as { id: string; received_at: string }[];

    for (const lead of leads) {
      res.considered++;
      const verdict = await evaluateLeadRouting(db, { orgId, leadEventId: lead.id, now });
      if (!verdict) continue;

      if (verdict.winner) {
        const reason = {
          won_by: "priority",
          priority: verdict.winner.priority,
          campaign_id: verdict.winner.campaign_id,
          // The full picture, not just the winner: an operator asking "why this
          // campaign and not that one" needs the rejected candidates too.
          skipped: verdict.candidates
            .filter((c) => c.campaign_id !== verdict.winner!.campaign_id)
            .map((c) => ({ campaign_id: c.campaign_id, eligible: c.eligible, detail: c.detail })),
          creative_check: "deferred_p5",
          evaluated_at: now.toISOString(),
        };
        try {
          await db.execute(sql`
            INSERT INTO drip_journeys
              (org_id, campaign_id, contact_id, lead_event_id, state, routed_at, reason)
            VALUES (${orgId}::uuid, ${verdict.winner.campaign_id}, ${verdict.contact_id}::uuid,
                    ${verdict.lead_event_id}::uuid, 'routed', ${now.toISOString()}::timestamptz,
                    ${JSON.stringify(reason)}::jsonb)
          `);
          res.routed++;
          const k = String(verdict.winner.campaign_id);
          res.byCampaign[k] = (res.byCampaign[k] ?? 0) + 1;
        } catch (e) {
          const code = (e as { cause?: { code?: string } })?.cause?.code;
          if (code === "23505") {
            // Lost the race — the invariant did its job. Not an error.
            res.lostRace++;
          } else {
            throw e;
          }
        }
        continue;
      }

      // Nothing matched. Age it out or leave it for the next tick.
      const ageDays = (now.getTime() - new Date(lead.received_at).getTime()) / 86400000;
      if (ageDays > DRIP_UNROUTABLE_TTL_DAYS) {
        const reason = {
          unroutable_after_days: DRIP_UNROUTABLE_TTL_DAYS,
          global: verdict.global,
          global_detail: verdict.globalDetail,
          candidates: verdict.candidates.map((c) => ({
            campaign_id: c.campaign_id, detail: c.detail,
          })),
          evaluated_at: now.toISOString(),
        };
        try {
          // ⚠️ campaign_id is NULL here, and that is the correct value — an
          // unroutable lead matched NOTHING, so naming a campaign would inflate
          // that campaign's journey count and lie to the debugging tool. The
          // 0163 CHECK permits NULL only for this state.
          await db.execute(sql`
            INSERT INTO drip_journeys
              (org_id, campaign_id, contact_id, lead_event_id, state, routed_at, reason)
            VALUES (${orgId}::uuid, NULL, ${verdict.contact_id}::uuid,
                    ${verdict.lead_event_id}::uuid, 'unroutable',
                    ${now.toISOString()}::timestamptz, ${JSON.stringify(reason)}::jsonb)
          `);
          res.markedUnroutable++;
        } catch (e) {
          const code = (e as { cause?: { code?: string } })?.cause?.code;
          if (code !== "23505") throw e;
          res.lostRace++;
        }
      } else {
        res.unrouted++;
      }
    }
  }

  return res;
}
