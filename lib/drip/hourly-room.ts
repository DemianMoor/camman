// lib/drip/hourly-room.ts
import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { HOUR_MS } from "./hourly-cap";
import type { DripTx } from "./hourly-maintenance";
import type { StageWindow } from "./windows";

// ⭐ THE ONE hourly-room formula (spec 2026-10-14 §1). Every "how full is this hour" count lives
// here; hourly-maintenance.ts (and, later, routing) import it. No other lib/drip file may
// re-derive these counts — scripts/test-drip-hourly-room.ts G1 enforces it.
//
//   sentH         first sends with first_send_at in [H, H+1h)
//   assigned      routed, unsent, hour_start = H
//   queued        routed, unsent, hour_start < H   (carry ON only — OFF closes them)
//   pendingFresh  routed, unsent, hour_start IS NULL, routed_at in [H, H+1h), routed ET minute in a window
//   committed = sentH + assigned + pendingFresh + queued; full ⇔ committed >= cap.
// pendingFresh → assigned (maintenance assignFresh) → sent each keep `committed` unchanged.

export interface HourCounts { sentH: number; assigned: number; queued: number; pendingFresh: number }
export interface HourCampaign { id: number; windows: StageWindow[] }

export function hourCommitted(c: HourCounts): number {
  return c.sentH + c.assigned + c.queued + c.pendingFresh;
}

export function hourFullness(cap: number, c: HourCounts): { full: boolean; committed: number; detail: string | null } {
  const committed = hourCommitted(c);
  const full = committed >= cap;
  return { full, committed, detail: full ? `hour full (${committed}/${cap} this hour)` : null };
}

/** One definition of "this journey's routed ET minute is inside a first-send window" (half-open [start,end)). Alias `j`. */
export function routedInWindowSql(windows: StageWindow[]): SQL {
  if (windows.length === 0) return sql`false`;
  const etMin = sql`(extract(hour FROM j.routed_at AT TIME ZONE 'America/New_York') * 60
                     + extract(minute FROM j.routed_at AT TIME ZONE 'America/New_York'))`;
  return sql.join(
    windows.map((w) => sql`(${etMin} >= ${w.window_start_min} AND ${etMin} < ${w.window_end_min})`),
    sql` OR `,
  );
}

const intArr = (ids: number[]) => `{${ids.join(",")}}`;

/** Hour counts for many campaigns in ONE grouped query. Every requested id gets an entry. */
export async function loadHourCounts(
  dbc: DripTx, { campaigns, hourStart }: { campaigns: HourCampaign[]; hourStart: Date },
): Promise<Map<number, HourCounts>> {
  const out = new Map<number, HourCounts>();
  for (const c of campaigns) out.set(c.id, { sentH: 0, assigned: 0, queued: 0, pendingFresh: 0 });
  if (campaigns.length === 0) return out;
  const h = hourStart.toISOString();
  const hEnd = new Date(hourStart.getTime() + HOUR_MS).toISOString();
  const withWindows = campaigns.filter((c) => c.windows.length > 0);
  const inWindow = withWindows.length === 0
    ? sql`false`
    : sql`CASE j.campaign_id ${sql.join(
        withWindows.map((c) => sql`WHEN ${c.id} THEN (${routedInWindowSql(c.windows)})`), sql` `)} ELSE false END`;
  const rows = (await dbc.execute(sql`
    SELECT j.campaign_id,
      count(*) FILTER (WHERE j.first_send_at >= ${h}::timestamptz AND j.first_send_at < ${hEnd}::timestamptz)::int AS sent_h,
      count(*) FILTER (WHERE j.state = 'routed' AND j.first_send_at IS NULL AND j.hour_start = ${h}::timestamptz)::int AS assigned,
      count(*) FILTER (WHERE j.state = 'routed' AND j.first_send_at IS NULL AND j.hour_start < ${h}::timestamptz)::int AS queued,
      count(*) FILTER (WHERE j.state = 'routed' AND j.first_send_at IS NULL AND j.hour_start IS NULL
                         AND j.routed_at >= ${h}::timestamptz AND j.routed_at < ${hEnd}::timestamptz
                         AND (${inWindow}))::int AS pending_fresh
    FROM drip_journeys j
    WHERE j.campaign_id = ANY(${intArr(campaigns.map((c) => c.id))}::int[])
      AND ((j.first_send_at >= ${h}::timestamptz AND j.first_send_at < ${hEnd}::timestamptz)
           OR (j.state = 'routed' AND j.first_send_at IS NULL))
    GROUP BY j.campaign_id
  `)) as unknown as { campaign_id: number; sent_h: number; assigned: number; queued: number; pending_fresh: number }[];
  for (const r of rows) {
    out.set(Number(r.campaign_id), {
      sentH: Number(r.sent_h), assigned: Number(r.assigned), queued: Number(r.queued), pendingFresh: Number(r.pending_fresh),
    });
  }
  return out;
}

/** Unsent journeys assigned to hour H, split fresh vs backlog (maintenance's release arithmetic needs the split). */
export async function loadAssignedSplit(
  dbc: DripTx, campaignId: number, hourStart: Date,
): Promise<{ fresh: number; backlog: number }> {
  const h = hourStart.toISOString();
  const r = (await dbc.execute(sql`
    SELECT
      count(*) FILTER (WHERE j.hour_start = ${h}::timestamptz AND j.hour_fresh)::int     AS fresh,
      count(*) FILTER (WHERE j.hour_start = ${h}::timestamptz AND NOT j.hour_fresh)::int AS backlog
    FROM drip_journeys j
    WHERE j.campaign_id = ${campaignId} AND j.state = 'routed' AND j.first_send_at IS NULL AND j.hour_start IS NOT NULL
  `)) as unknown as { fresh: number; backlog: number }[];
  return { fresh: Number(r[0]?.fresh ?? 0), backlog: Number(r[0]?.backlog ?? 0) };
}

/** Backlog first sends in hour H (hour_fresh IS FALSE) — the `B` of planHourEnd. */
export async function loadBacklogSentInHour(dbc: DripTx, campaignId: number, hourStart: Date): Promise<number> {
  const r = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM drip_journeys j
    WHERE j.campaign_id = ${campaignId}
      AND j.first_send_at >= ${hourStart.toISOString()}::timestamptz
      AND j.first_send_at <  ${new Date(hourStart.getTime() + HOUR_MS).toISOString()}::timestamptz
      AND j.hour_fresh IS FALSE
  `)) as unknown as { n: number }[];
  return Number(r[0]?.n ?? 0);
}

export type OpenWindow = StageWindow & { creative_text: string | null };

/** Active first-send windows per campaign (drip_active, not archived, top-level stage) + creative text. Every id gets an entry. */
export async function loadOpenWindowCampaigns(
  dbc: DripTx, { campaignIds }: { campaignIds: number[] },
): Promise<Map<number, OpenWindow[]>> {
  const out = new Map<number, OpenWindow[]>();
  for (const id of campaignIds) out.set(id, []);
  if (campaignIds.length === 0) return out;
  const rows = (await dbc.execute(sql`
    SELECT s.campaign_id, s.id AS stage_id, s.window_start_min, s.window_end_min, cr.text AS creative_text
    FROM campaign_stages s LEFT JOIN creatives cr ON cr.id = s.creative_id
    WHERE s.campaign_id = ANY(${intArr(campaignIds)}::int[]) AND s.drip_active IS TRUE AND s.archived_at IS NULL
      AND s.parent_stage_id IS NULL AND s.window_start_min IS NOT NULL AND s.window_end_min IS NOT NULL
  `)) as unknown as (OpenWindow & { campaign_id: number })[];
  for (const { campaign_id, ...w } of rows) out.get(Number(campaign_id))?.push(w);
  return out;
}
