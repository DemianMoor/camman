import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { isDripPostureOn } from "./in-use";
import {
  classifyRoutingOutcome,
  evaluateLeadRouting,
  loadCampaignJourneyCounts,
} from "./routing-eval";

// The drip routing worker (Drip Phase 4). ZERO SENDS.
//
// Takes processed leads that have no journey yet, evaluates them against every
// drip campaign, and writes at most ONE journey each. Nothing here can message
// anyone; the scheduler queues, the drain sends.
//
// ⭐ THE UNIQUE VIOLATION IS A NORMAL OUTCOME, NOT AN ERROR.
// drip_journeys carries a partial unique on (org_id, contact_id) for live
// states. That index — not this code — is what guarantees "exactly one
// campaign". So the insert is optimistic and a 23505 means "another tick, or
// another lead for the same contact in this very batch, got there first":
// skip and move on. Treating it as a failure would turn the invariant working
// correctly into an alert.
//
// ⭐ EVERY UNROUTED LEAD LEAVES THE HEAD OF THE QUEUE (card 869ency4b, 2026-10-10).
// Candidates used to be "the 200 oldest leads with no journey", and an unrouted
// lead got no row for 7 days — so ~180 dead leads (opted out, in use) sat at
// the head of every batch and 44,968 routable leads behind them never got a
// turn. Now each verdict is classified (classifyRoutingOutcome):
//   permanent → terminal 'unroutable' row on the FIRST evaluation;
//   defer     → lead_events.drip_recheck_at = now + DRIP_RECHECK_MINUTES, and
//               never-evaluated leads are always taken first;
//   expired   → past its freshness cutoff: re-check stamp only, nothing terminal.
//
// ⭐ FRESHNESS (drip only). A lead is admitted only until the end of its ARRIVAL
// ET DAY plus a cutoff (org_settings.drip_admission_cutoff_minutes, default 0,
// per-campaign drip_campaign_configs.admission_cutoff_minutes). The candidate
// query never looks below the earliest arrival day any campaign could still
// admit, so older leads are never evaluated and never written to — they stay
// ordinary contacts, usable in regular campaigns, groups and segments.
//
// ⭐ THROUGHPUT: up to DRIP_ROUTING_BATCH per tick within DRIP_ROUTING_DEADLINE_MS
// (the route's maxDuration is 60 s). Campaign journey counts are read ONCE per
// tick and incremented as journeys are inserted, instead of being recounted
// inside every evaluation.

export const DRIP_ROUTING_BATCH = 600;
export const DRIP_ROUTING_DEADLINE_MS = 45_000;
export const DRIP_RECHECK_MINUTES = 15;

export interface RoutingResult {
  postureOn: boolean;
  considered: number;
  routed: number;
  markedUnroutable: number;
  deferred: number;
  expired: number;
  lostRace: number;
  hitDeadline: boolean;
  elapsedMs: number;
  byCampaign: Record<string, number>;
}

export async function runDripRoutingBatch(
  now: Date = new Date(),
  opts: { batchSize?: number; deadlineMs?: number; onlyOrgId?: string } = {},
): Promise<RoutingResult> {
  const batchSize = opts.batchSize ?? DRIP_ROUTING_BATCH;
  const deadlineMs = opts.deadlineMs ?? DRIP_ROUTING_DEADLINE_MS;
  const startedAt = Date.now();
  const res: RoutingResult = {
    postureOn: false, considered: 0, routed: 0, markedUnroutable: 0, deferred: 0,
    expired: 0, lostRace: 0, hitDeadline: false, elapsedMs: 0, byCampaign: {},
  };

  const orgs = (await db.execute(sql`
    SELECT org_id FROM org_settings WHERE drip_enabled = true AND drip_paused = false
  `)) as unknown as { org_id: string }[];
  if (orgs.length === 0) return res;
  res.postureOn = true;

  for (const { org_id: orgId } of orgs) {
    // Tests scope a run to their own throwaway org.
    if (opts.onlyOrgId && orgId !== opts.onlyOrgId) continue;
    // Belt and braces: the loop above already filtered, but posture is the flag
    // that also gates the in-use SQL shape, so it is read through one helper.
    if (!(await isDripPostureOn(orgId))) continue;

    // The earliest arrival a campaign could still admit: the largest cutoff in
    // play (org default or any live/paused campaign's override).
    const cut = (await db.execute(sql`
      SELECT GREATEST(
        COALESCE((SELECT drip_admission_cutoff_minutes FROM org_settings WHERE org_id = ${orgId}::uuid), 0),
        COALESCE((SELECT max(cfg.admission_cutoff_minutes)
                  FROM drip_campaign_configs cfg JOIN campaigns c ON c.id = cfg.campaign_id
                  WHERE c.org_id = ${orgId}::uuid AND c.type = 'drip'
                    AND c.status IN ('active', 'paused')), 0)
      )::int AS max_cutoff
    `)) as unknown as { max_cutoff: number }[];
    const maxCutoffMin = Number(cut[0]?.max_cutoff ?? 0);
    const floor = campaignDayBoundsUtc(new Date(now.getTime() - maxCutoffMin * 60_000)).start;

    // Candidates: fresh enough, no journey yet, not deferred into the future.
    // Never-evaluated leads first (oldest first), then due re-checks.
    const leads = (await db.execute(sql`
      SELECT e.id
      FROM lead_events e
      WHERE e.org_id = ${orgId}::uuid
        AND e.sandbox = false
        AND e.received_at >= ${floor.toISOString()}::timestamptz
        AND (e.drip_recheck_at IS NULL OR e.drip_recheck_at <= ${now.toISOString()}::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM drip_journeys j WHERE j.lead_event_id = e.id)
      ORDER BY (e.drip_recheck_at IS NOT NULL), e.received_at
      LIMIT ${batchSize}
    `)) as unknown as { id: string }[];
    if (leads.length === 0) continue;

    const counts = await loadCampaignJourneyCounts(db, { orgId, now });
    const recheckAt = new Date(now.getTime() + DRIP_RECHECK_MINUTES * 60_000).toISOString();

    for (const lead of leads) {
      if (Date.now() - startedAt > deadlineMs) {
        // The rest stay unevaluated and head the next tick — nothing is lost.
        res.hitDeadline = true;
        break;
      }
      res.considered++;
      const verdict = await evaluateLeadRouting(db, { orgId, leadEventId: lead.id, now, counts });
      if (!verdict) continue;
      const outcome = classifyRoutingOutcome(verdict);

      if (outcome === "route" && verdict.winner) {
        const reason = {
          won_by: "priority",
          priority: verdict.winner.priority,
          campaign_id: verdict.winner.campaign_id,
          // The full picture, not just the winner: an operator asking "why this
          // campaign and not that one" needs the rejected candidates too.
          skipped: verdict.candidates
            .filter((c) => c.campaign_id !== verdict.winner!.campaign_id)
            .map((c) => ({ campaign_id: c.campaign_id, eligible: c.eligible, detail: c.detail })),
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
          // Keep the per-tick cap counts true for the next evaluation.
          const c = counts.get(verdict.winner.campaign_id) ?? { total: 0, today: 0 };
          counts.set(verdict.winner.campaign_id, { total: c.total + 1, today: c.today + 1 });
        } catch (e) {
          if (codeOf(e) === "23505") {
            // Lost the race — the invariant did its job. Not an error. The
            // contact now has a live journey, so the next look defers it.
            res.lostRace++;
            await stampRecheck(verdict.lead_event_id, recheckAt);
          } else {
            throw e;
          }
        }
        continue;
      }

      if (outcome === "permanent") {
        const reason = {
          permanent: true,
          global: verdict.global,
          global_detail: verdict.globalDetail,
          candidates: verdict.candidates.map((c) => ({
            campaign_id: c.campaign_id, rules: c.rules, detail: c.detail,
          })),
          evaluated_at: now.toISOString(),
        };
        try {
          // ⚠️ campaign_id is NULL here, and that is the correct value — an
          // unroutable lead matched NOTHING, so naming a campaign would inflate
          // that campaign's journey count and lie to the debugging tool. The
          // 0163 CHECK permits NULL only for this state.
          //
          // ⚠️ closed_at is REQUIRED: drip_journeys_closed_at_check demands it on
          // every state other than routed/active, and 'unroutable' is terminal.
          await db.execute(sql`
            INSERT INTO drip_journeys
              (org_id, campaign_id, contact_id, lead_event_id, state, routed_at, closed_at, reason)
            VALUES (${orgId}::uuid, NULL, ${verdict.contact_id}::uuid,
                    ${verdict.lead_event_id}::uuid, 'unroutable',
                    ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz,
                    ${JSON.stringify(reason)}::jsonb)
          `);
          res.markedUnroutable++;
        } catch (e) {
          if (codeOf(e) !== "23505") throw e;
          res.lostRace++;
        }
        continue;
      }

      // defer / expired: step aside until the re-check time. An expired lead is
      // never written to beyond this stamp; it falls below the floor at the end
      // of its admission window and is never looked at again.
      await stampRecheck(verdict.lead_event_id, recheckAt);
      if (outcome === "defer") res.deferred++;
      else res.expired++;
    }
  }

  res.elapsedMs = Date.now() - startedAt;
  return res;
}

async function stampRecheck(leadEventId: string, at: string): Promise<void> {
  await db.execute(sql`
    UPDATE lead_events SET drip_recheck_at = ${at}::timestamptz WHERE id = ${leadEventId}::uuid
  `);
}

function codeOf(e: unknown): string | undefined {
  return (e as { cause?: { code?: string } })?.cause?.code;
}
