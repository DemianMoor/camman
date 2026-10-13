// lib/drip/hourly-maintenance.ts
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { isDripSendingHalted } from "@/lib/sends/circuit-breakers";
import {
  backlogRoom, hourStartOf, HOUR_MS, minutesIntoHour, MISSED_HOUR_CLOSE_REASON,
  planHourEnd, type FreshUnsent, type HourCounts, type MissedHourCause,
} from "./hourly-cap";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { numbersWithHeadroom, pickNumber } from "./numbers";
import { pickStage, etMinutesOfDay, type StageWindow } from "./windows";

// Drip hourly send cap — the per-run maintenance pass (spec 2026-10-13 §4).
// Runs inside the scheduler's single-flight lease, BEFORE the due query, so the
// room it returns is what selectDueJourneys may take this run.
//
// ⭐ NOTHING HERE SENDS. It only moves journeys between "waiting" (hour_start
// NULL), "on an hour", and — OFF only — the terminal expired/missed_hour_*.
// ⭐ A STOP CONTROL NEVER CAUSES A DROP. Pause / halt / flag off / no headroom
// revert assignments to waiting; only a campaign that could send drops leads.
//   Per-campaign order in prepareHourly: assign fresh → "able to send?" check →
//   if NOT able, revert + room 0 and STOP (closePastHours is not run, so a stop
//   control never causes a drop, even at the hour boundary) → if able, close past
//   hours (OFF only) → release backlog → room. This deliberately overrides the
//   spec's §4 step order (owner invariant).

export type DripTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface HourlyRoom { hourStart: Date; room: number; carry: boolean }
export type HourlyRoomMap = Map<number, HourlyRoom>;

const uuidArr = (ids: string[]) => `{${ids.join(",")}}`;
const LIVE_UNSENT = sql`j.state = 'routed' AND j.first_send_at IS NULL`;

/** Step 0: every unsent assignment whose org/campaign can no longer use the cap → waiting. */
export async function clearIneligibleHourAssignments(dbc: DripTx): Promise<number> {
  const rows = (await dbc.execute(sql`
    UPDATE drip_journeys j SET hour_start = NULL, hour_fresh = NULL
    FROM campaigns c
    LEFT JOIN drip_campaign_configs cfg ON cfg.campaign_id = c.id
    LEFT JOIN org_settings os ON os.org_id = c.org_id
    WHERE j.campaign_id = c.id AND ${LIVE_UNSENT} AND j.hour_start IS NOT NULL
      AND (NOT COALESCE(os.drip_enabled, false) OR COALESCE(os.drip_paused, false)
           OR NOT COALESCE(os.drip_hourly_cap_enabled, false)
           OR c.status <> 'active' OR c.send_paused IS TRUE OR cfg.hourly_cap IS NULL)
    RETURNING j.id
  `)) as unknown as { id: string }[];
  return rows.length;
}

export async function revertCampaign(dbc: DripTx, campaignId: number): Promise<number> {
  const rows = (await dbc.execute(sql`
    UPDATE drip_journeys j SET hour_start = NULL, hour_fresh = NULL
    WHERE j.campaign_id = ${campaignId} AND ${LIVE_UNSENT} AND j.hour_start IS NOT NULL
    RETURNING j.id`)) as unknown as { id: string }[];
  return rows.length;
}

/**
 * Stamp a refused send on a still-unsent journey (feeds the `blocked` drop cause).
 * Callers MUST only call this for hourly-capped campaigns (spec: zero writes otherwise).
 */
export async function recordSendRefusal(
  dbc: DripTx, { journeyId, kind, now }: { journeyId: string; kind: "mint" | "gate"; now: Date },
): Promise<void> {
  await dbc.execute(sql`
    UPDATE drip_journeys
    SET reason = COALESCE(reason, '{}'::jsonb)
               || jsonb_build_object('last_send_refusal',
                    jsonb_build_object('kind', ${kind}::text, 'at', ${now.toISOString()}::text))
    WHERE id = ${journeyId}::uuid AND state = 'routed' AND first_send_at IS NULL`);
}

/** One definition of "this journey's routed ET minute is inside a first-send window" (half-open [start,end)). */
function routedInAnyWindow(windows: StageWindow[]) {
  const etMin = sql`(extract(hour FROM j.routed_at AT TIME ZONE 'America/New_York') * 60
                     + extract(minute FROM j.routed_at AT TIME ZONE 'America/New_York'))`;
  return sql.join(
    windows.map((w) => sql`(${etMin} >= ${w.window_start_min} AND ${etMin} < ${w.window_end_min})`),
    sql` OR `,
  );
}

/**
 * Owner ruling 2026-10-13: an operator action must never drop leads. A fresh lead whose routed
 * minute is no longer covered by any CURRENTLY active first-send window (stage deactivated,
 * archived, or its window edited away) reverts to waiting instead of being dropped at hour end.
 */
async function revertOrphanedFresh(dbc: DripTx, campaignId: number, windows: StageWindow[]): Promise<number> {
  const covered = windows.length > 0 ? sql`NOT (${routedInAnyWindow(windows)})` : sql`true`;
  const rows = (await dbc.execute(sql`
    UPDATE drip_journeys j SET hour_start = NULL, hour_fresh = NULL
    WHERE j.campaign_id = ${campaignId} AND ${LIVE_UNSENT} AND j.hour_fresh IS TRUE AND ${covered}
    RETURNING j.id`)) as unknown as { id: string }[];
  return rows.length;
}

async function assignFresh(dbc: DripTx, campaignId: number, hour: Date, windows: StageWindow[]) {
  if (windows.length === 0) return;
  const inWindow = routedInAnyWindow(windows);
  await dbc.execute(sql`
    UPDATE drip_journeys j SET hour_start = ${hour.toISOString()}::timestamptz, hour_fresh = true
    WHERE j.campaign_id = ${campaignId} AND ${LIVE_UNSENT} AND j.hour_start IS NULL
      AND j.routed_at >= ${hour.toISOString()}::timestamptz
      AND j.routed_at <  ${new Date(hour.getTime() + HOUR_MS).toISOString()}::timestamptz
      AND (${inWindow})`);
}

async function sentBetween(dbc: DripTx, campaignId: number, from: Date, backlogOnly: boolean) {
  const r = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM drip_journeys j
    WHERE j.campaign_id = ${campaignId}
      AND j.first_send_at >= ${from.toISOString()}::timestamptz
      AND j.first_send_at <  ${new Date(from.getTime() + HOUR_MS).toISOString()}::timestamptz
      ${backlogOnly ? sql`AND j.hour_fresh IS FALSE` : sql``}
  `)) as unknown as { n: number }[];
  return Number(r[0]?.n ?? 0);
}

/** Step 2 (OFF): close every past hour. Returns per-cause drops and the hours with blocked drops. */
async function closePastHours(
  dbc: DripTx, campaignId: number, cap: number, hour: Date,
): Promise<{ dropped: Record<MissedHourCause, number>; demoted: number; blockedHours: Map<string, number> }> {
  const out = { dropped: { cap: 0, closed: 0, blocked: 0 }, demoted: 0, blockedHours: new Map<string, number>() };
  // Released backlog is never dropped (R1).
  await dbc.execute(sql`
    UPDATE drip_journeys j SET hour_start = NULL, hour_fresh = NULL
    WHERE j.campaign_id = ${campaignId} AND ${LIVE_UNSENT}
      AND j.hour_start < ${hour.toISOString()}::timestamptz AND j.hour_fresh IS FALSE`);
  const rows = (await dbc.execute(sql`
    SELECT j.id, j.hour_start, j.routed_at,
           (j.reason -> 'last_send_refusal' ->> 'at')::timestamptz AS refused_at
    FROM drip_journeys j
    WHERE j.campaign_id = ${campaignId} AND ${LIVE_UNSENT}
      AND j.hour_start < ${hour.toISOString()}::timestamptz AND j.hour_fresh IS TRUE
  `)) as unknown as { id: string; hour_start: string; routed_at: string; refused_at: string | null }[];
  const byHour = new Map<number, FreshUnsent[]>();
  for (const r of rows) {
    const h = new Date(r.hour_start).getTime();
    const refused = r.refused_at ? new Date(r.refused_at).getTime() : null;
    const list = byHour.get(h) ?? [];
    list.push({ journeyId: r.id, routedAt: new Date(r.routed_at), blocked: refused != null && refused >= h && refused < h + HOUR_MS });
    byHour.set(h, list);
  }
  for (const [h, freshUnsent] of byHour) {
    const H = new Date(h);
    const sentInHour = await sentBetween(dbc, campaignId, H, false);
    const backlogSentInHour = await sentBetween(dbc, campaignId, H, true);
    const plan = planHourEnd({ cap, sentInHour, backlogSentInHour, freshUnsent });
    if (plan.demote.length > 0) {
      await dbc.execute(sql`
        UPDATE drip_journeys SET hour_start = NULL, hour_fresh = NULL
        WHERE id = ANY(${uuidArr(plan.demote)}::uuid[]) AND campaign_id = ${campaignId} AND state = 'routed' AND first_send_at IS NULL`);
      out.demoted += plan.demote.length;
    }
    for (const cause of ["cap", "closed", "blocked"] as const) {
      const ids = plan.drop.filter((d) => d.cause === cause).map((d) => d.journeyId);
      if (ids.length === 0) continue;
      await dbc.execute(sql`
        UPDATE drip_journeys
        SET state = 'expired', closed_at = now(), close_reason = ${MISSED_HOUR_CLOSE_REASON[cause]},
            reason = COALESCE(reason, '{}'::jsonb) || jsonb_build_object('missed_hour', jsonb_build_object(
              'hour_start', ${H.toISOString()}::text, 'cap', ${cap}::int, 'cause', ${cause}::text,
              'sent_in_hour', ${sentInHour}::int, 'backlog_sent_in_hour', ${backlogSentInHour}::int))
        WHERE id = ANY(${uuidArr(ids)}::uuid[]) AND campaign_id = ${campaignId} AND state = 'routed' AND first_send_at IS NULL`);
      out.dropped[cause] += ids.length;
      if (cause === "blocked") out.blockedHours.set(H.toISOString(), ids.length);
    }
  }
  return out;
}

async function hourCounts(dbc: DripTx, campaignId: number, hour: Date): Promise<HourCounts> {
  const h = hour.toISOString();
  const r = (await dbc.execute(sql`
    SELECT
      count(*) FILTER (WHERE j.hour_start = ${h}::timestamptz AND j.hour_fresh)::int     AS fresh,
      count(*) FILTER (WHERE j.hour_start = ${h}::timestamptz AND NOT j.hour_fresh)::int AS backlog,
      count(*) FILTER (WHERE j.hour_start < ${h}::timestamptz)::int                      AS queued
    FROM drip_journeys j
    WHERE j.campaign_id = ${campaignId} AND ${LIVE_UNSENT} AND j.hour_start IS NOT NULL
  `)) as unknown as { fresh: number; backlog: number; queued: number }[];
  return {
    sentInHour: await sentBetween(dbc, campaignId, hour, false),
    freshUnsentInHour: Number(r[0]?.fresh ?? 0),
    backlogUnsentInHour: Number(r[0]?.backlog ?? 0),
    queuedUnsent: Number(r[0]?.queued ?? 0),
  };
}

async function releaseBacklog(dbc: DripTx, campaignId: number, hour: Date, n: number): Promise<number> {
  if (n <= 0) return 0;
  const rows = (await dbc.execute(sql`
    UPDATE drip_journeys SET hour_start = ${hour.toISOString()}::timestamptz, hour_fresh = false
    WHERE campaign_id = ${campaignId} AND id IN (
      SELECT j.id FROM drip_journeys j
      WHERE j.campaign_id = ${campaignId} AND ${LIVE_UNSENT} AND j.hour_start IS NULL
      ORDER BY j.routed_at, j.id
      LIMIT ${n})
    RETURNING id`)) as unknown as { id: string }[];
  return rows.length;
}

export async function prepareHourly(
  dbc: DripTx,
  { orgId, now, notify, deps }: {
    orgId: string;
    now: Date;
    notify: (alertKey: string, orgId: string, text: string) => Promise<void>;
    /** Number headroom reader; the scheduler passes the real one. */
    deps: { hasHeadroom: (campaignId: number) => Promise<boolean> };
  },
): Promise<{ rooms: HourlyRoomMap; dropped: Record<MissedHourCause, number>; demoted: number; released: number; reverted: number }> {
  const res = { rooms: new Map() as HourlyRoomMap, dropped: { cap: 0, closed: 0, blocked: 0 }, demoted: 0, released: 0, reverted: 0 };
  const hour = hourStartOf(now);
  const camps = (await dbc.execute(sql`
    SELECT c.id, c.name, c.send_paused, cfg.hourly_cap, cfg.hourly_carry, cfg.campaign_cap,
           CASE WHEN cfg.campaign_cap IS NULL THEN 0
                ELSE (SELECT count(*)::int FROM drip_journeys dj WHERE dj.campaign_id = c.id AND dj.first_send_at IS NOT NULL)
           END AS lifetime
    FROM campaigns c
    JOIN drip_campaign_configs cfg ON cfg.campaign_id = c.id
    JOIN org_settings os ON os.org_id = c.org_id
    WHERE c.org_id = ${orgId}::uuid AND c.type = 'drip' AND c.status = 'active'
      AND cfg.hourly_cap IS NOT NULL AND os.drip_hourly_cap_enabled
  `)) as unknown as { id: number; name: string | null; send_paused: boolean | null; hourly_cap: number;
    hourly_carry: boolean; campaign_cap: number | null; lifetime: number }[];

  for (const c of camps) {
    const campaignId = Number(c.id);
    const cap = Number(c.hourly_cap);
    const windows = (await dbc.execute(sql`
      SELECT s.id AS stage_id, s.window_start_min, s.window_end_min, cr.text AS creative_text
      FROM campaign_stages s LEFT JOIN creatives cr ON cr.id = s.creative_id
      WHERE s.campaign_id = ${campaignId} AND s.drip_active IS TRUE AND s.archived_at IS NULL
        AND s.parent_stage_id IS NULL AND s.window_start_min IS NOT NULL AND s.window_end_min IS NOT NULL
    `)) as unknown as (StageWindow & { creative_text: string | null })[];

    // Step 1 — assign this hour's fresh leads.
    await assignFresh(dbc, campaignId, hour, windows);

    // Step 1b — stop control: fresh leads whose window an operator removed revert, never drop.
    res.reverted += await revertOrphanedFresh(dbc, campaignId, windows);

    // Step 2 — can this campaign send right now? Checked BEFORE closing past hours: a stop
    // control (pause / halt / lifetime cap / no number headroom) never causes a drop, even at
    // the hour boundary. Not able ⇒ revert to waiting, room 0, and closePastHours is skipped.
    // An open first-send stage with no creative text is skipped by the scheduler (`if
    // (!stage.creative_text) continue;`) — that must not turn into a drop either.
    const openPick = windows.length > 0 ? pickStage(windows, etMinutesOfDay(now)) : null;
    const openStage = openPick != null && openPick.opens_at_min === null
      ? windows.find((w) => w.stage_id === openPick.stage_id) : null;
    const hasCreative = openStage == null || !!openStage.creative_text;
    const able = !c.send_paused && hasCreative &&
      !(await isDripSendingHalted(dbc, campaignId)) &&
      !(c.campaign_cap != null && Number(c.lifetime) >= Number(c.campaign_cap)) &&
      (await deps.hasHeadroom(campaignId));
    if (!able) {
      res.reverted += await revertCampaign(dbc, campaignId);
      res.rooms.set(campaignId, { hourStart: hour, room: 0, carry: c.hourly_carry });
      continue;
    }

    // Step 3 (OFF only) — close every past hour; only a campaign that could send gets here.
    if (!c.hourly_carry) {
      const closed = await closePastHours(dbc, campaignId, cap, hour);
      for (const k of ["cap", "closed", "blocked"] as const) res.dropped[k] += closed.dropped[k];
      res.demoted += closed.demoted;
      for (const [h, n] of closed.blockedHours) {
        await notify(`drip:missed_hour_blocked:${campaignId}:${h}`, orgId,
          `⚠️ Drip campaign "${c.name ?? campaignId}": ${n} lead(s) dropped for the ${formatCampaignDateTime(h)} hour because their send was ` +
          `refused (opt-out gate / link mint). This is a system fault, not lead staleness — check the stage's link and footer.`);
      }
    }

    // Step 4 — release waiting leads into spare room, only while a window is open.
    const pick = windows.length > 0 ? pickStage(windows, etMinutesOfDay(now)) : null;
    const windowOpen = pick != null && pick.opens_at_min === null;
    let counts = await hourCounts(dbc, campaignId, hour);
    if (windowOpen) {
      const n = backlogRoom({ cap, carry: c.hourly_carry, counts, minutesIntoHour: minutesIntoHour(now) });
      const released = await releaseBacklog(dbc, campaignId, hour, n);
      res.released += released;
      if (released > 0) counts = await hourCounts(dbc, campaignId, hour);
    }
    // Step 5 — room this run (the scheduler also applies the daily cap).
    res.rooms.set(campaignId, { hourStart: hour, room: Math.max(0, cap - counts.sentInHour), carry: c.hourly_carry });
  }
  return res;
}

/** The scheduler's headroom reader. */
export async function realHasHeadroom(campaignId: number, now: Date): Promise<boolean> {
  return pickNumber(await numbersWithHeadroom(db, { campaignId, now })) != null;
}

/**
 * Carry ON → OFF on save: EVERY assigned unsent journey reverts to waiting (spec §5). Under ON
 * the queue's sends are hour_fresh = true and not counted as backlog, so a current-hour fresh
 * lead would be judged with B = 0 and could be dropped; reverting all makes it backlog instead.
 */
export async function applyHourlyCarryTransition(
  dbc: DripTx,
  { campaignId, before, after }: { campaignId: number; before: boolean; after: boolean; now: Date },
): Promise<number> {
  if (!(before && !after)) return 0;
  return revertCampaign(dbc, campaignId);
}
