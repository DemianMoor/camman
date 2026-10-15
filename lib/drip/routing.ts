import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { scanFloor, type AdmissionSettings } from "./admission-window";
import { isDripPostureOn } from "./in-use";
import {
  classifyRoutingOutcome,
  evaluateLeadRouting,
  loadCampaignJourneyCounts,
  ZERO_COUNTS,
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
// ⭐ FRESHNESS + CARRY-OVER (drip only). A lead is admitted only until the end
// of (its ARRIVAL ET DAY + carry days) + a cutoff — lib/drip/admission-window.ts.
// Carry defaults to 0 (same day only). The candidate query never looks below
// the earliest arrival any campaign could still admit, and that floor never
// goes below a widening, so leads freshness already skipped are never
// evaluated or written to again. Today's arrivals are evaluated before carried
// ones, and a carried lead only uses cap left after a reserve (routing-eval.ts).
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

    // The earliest arrival any live/paused campaign (or the org default) could
    // still admit. ⭐ scanFloor never goes below a campaign's widened_at (except
    // today's own arrivals), so leads that expired before a widening — the
    // Oct-10/11 backlog, anything freshness already skipped — never re-enter.
    const settingRows = (await db.execute(sql`
      SELECT cfg.carry_days, cfg.admission_cutoff_minutes, cfg.admission_widened_at,
             os.drip_carry_days, os.drip_admission_cutoff_minutes, os.drip_admission_widened_at
      FROM org_settings os
      LEFT JOIN campaigns c ON c.org_id = os.org_id AND c.type = 'drip' AND c.status IN ('active', 'paused')
      LEFT JOIN drip_campaign_configs cfg ON cfg.campaign_id = c.id
      WHERE os.org_id = ${orgId}::uuid
    `)) as unknown as {
      carry_days: number | null; admission_cutoff_minutes: number | null; admission_widened_at: string | null;
      drip_carry_days: number; drip_admission_cutoff_minutes: number; drip_admission_widened_at: string | null;
    }[];
    const settingsOf = (r: (typeof settingRows)[number], orgOnly: boolean): AdmissionSettings => ({
      cfgCarryDays: orgOnly ? null : r.carry_days,
      cfgCutoffMinutes: orgOnly ? null : r.admission_cutoff_minutes,
      cfgWidenedAt: orgOnly ? null : r.admission_widened_at,
      orgCarryDays: r.drip_carry_days, orgCutoffMinutes: r.drip_admission_cutoff_minutes,
      orgWidenedAt: r.drip_admission_widened_at,
    });
    const floorMs = Math.min(
      // the org default too, as the old GREATEST(org, max(cfg)) did
      ...(settingRows.length > 0 ? [scanFloor(now, settingsOf(settingRows[0], true)).getTime()] : []),
      ...settingRows.map((r) => scanFloor(now, settingsOf(r, false)).getTime()),
      campaignDayBoundsUtc(now).start.getTime(),
    );
    const floor = new Date(floorMs);
    const todayStart = campaignDayBoundsUtc(now).start;

    // Candidates: fresh enough, no journey yet, not deferred into the future.
    const leads = (await db.execute(sql`
      SELECT e.id
      FROM lead_events e
      WHERE e.org_id = ${orgId}::uuid
        AND e.sandbox = false
        AND e.received_at >= ${floor.toISOString()}::timestamptz
        AND (e.drip_recheck_at IS NULL OR e.drip_recheck_at <= ${now.toISOString()}::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM drip_journeys j WHERE j.lead_event_id = e.id)
      -- ⭐ Fresh leads first (carry-over D1): today's arrivals, never-evaluated
      -- before re-checks, oldest first (#335, unchanged); then carried leads,
      -- never-evaluated before re-checks, NEWEST first (day 1 before day 2).
      ORDER BY (e.received_at < ${todayStart.toISOString()}::timestamptz),
               (e.drip_recheck_at IS NOT NULL),
               CASE WHEN e.received_at < ${todayStart.toISOString()}::timestamptz
                    THEN -extract(epoch FROM e.received_at)
                    ELSE extract(epoch FROM e.received_at) END
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
          // Higher-priority campaigns passed over only because they were full
          // today (0210). Absent unless the lead actually overflowed.
          ...(verdict.overflowed_from.length > 0 && {
            overflowed_from: verdict.overflowed_from,
            campaign_name: verdict.winner.campaign_name,
          }),
          // O3 (0213): routed although every candidate was hour-full. Absent
          // otherwise, so flag-off reasons stay byte-identical.
          ...(verdict.hour_fallback && { hour_fallback: true }),
          evaluated_at: now.toISOString(),
        };
        try {
          await db.execute(sql`
            INSERT INTO drip_journeys
              (org_id, campaign_id, contact_id, lead_event_id, state, routed_at, reason, carried_days)
            VALUES (${orgId}::uuid, ${verdict.winner.campaign_id}, ${verdict.contact_id}::uuid,
                    ${verdict.lead_event_id}::uuid, 'routed', ${now.toISOString()}::timestamptz,
                    ${JSON.stringify(reason)}::jsonb,
                    GREATEST(0, (${now.toISOString()}::timestamptz AT TIME ZONE 'America/New_York')::date
                              - (${verdict.received_at}::timestamptz AT TIME ZONE 'America/New_York')::date))
          `);
          res.routed++;
          const k = String(verdict.winner.campaign_id);
          res.byCampaign[k] = (res.byCampaign[k] ?? 0) + 1;
          // Keep the per-tick cap counts true for the next evaluation.
          // `unsent` too: the new journey is routed and unsent, so it is U in the
          // send-capacity rule (0210) — without it one tick could overfill.
          // `hour.pendingFresh` too (0213): `hour` is non-null only while the
          // campaign's window is open now, so this journey — routed now — is
          // pending fresh in this hour, exactly as loadHourCounts will count it.
          const c = counts.get(verdict.winner.campaign_id) ?? ZERO_COUNTS;
          counts.set(verdict.winner.campaign_id, {
            ...c, total: c.total + 1, today: c.today + 1, unsent: c.unsent + 1,
            hour: c.hour && {
              ...c.hour, counts: { ...c.hour.counts, pendingFresh: c.hour.counts.pendingFresh + 1 },
            },
          });
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
