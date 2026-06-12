import { inArray, sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { campaign_stages, campaigns, keitaro_stage_results } from "@/db/schema";
import {
  CAMPAIGN_TIMEZONE,
  formatInCampaignTimezone,
} from "@/lib/campaign-timezone";
import {
  buildKeitaroReport,
  type KeitaroReportRow,
} from "@/lib/keitaro/client";

export type Database = typeof db;

// Rolling window: re-read the last N days every poll. Conversions arrive late
// (the affiliate fires the postback minutes-to-hours after the click), so a
// multi-day window catches late sales attaching to earlier clicks. Re-reading
// stable older days is cheap and the UPSERT is idempotent.
const DEFAULT_WINDOW_DAYS = 3;

export interface KeitaroPollResult {
  ok: boolean;
  // false ⇒ the report fetch failed; rows were left untouched for next cycle.
  degraded: boolean;
  range: { from: string; to: string; timezone: string };
  fetched: number; // report rows returned by Keitaro
  matched: number; // rows whose sub_id_3 mapped to a CamMan stage
  upserted: number; // rows written
  unmatched: number; // rows skipped (no/blank/unknown sub_id_3)
  errored: number; // rows that threw during upsert
  // A few unmatched sub_id_3 values, for debugging what Keitaro actually sends.
  unmatched_samples: string[];
  error: string | null;
}

function toInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// Keep money/EPC as a decimal string for the NUMERIC column (no float drift).
function toNumericString(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n.toFixed(4) : "0.0000";
}

// Extract a YYYY-MM-DD date from Keitaro's `day` grouping value (which may be a
// bare date or a full datetime string). Returns null if no date is present.
function extractDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

// Resolve a batch of sub_id_3 values (= stage tracking ids) to their CamMan
// stage/campaign/org in one query. A tracking_id is unique per org; on the rare
// cross-org collision we drop it (ambiguous) rather than guess.
async function resolveStages(
  database: Database,
  trackingIds: string[],
): Promise<Map<string, { stageId: number; campaignId: number; orgId: string }>> {
  const map = new Map<
    string,
    { stageId: number; campaignId: number; orgId: string }
  >();
  if (trackingIds.length === 0) return map;

  const rows = await database
    .select({
      stage_id: campaign_stages.id,
      campaign_id: campaign_stages.campaign_id,
      org_id: campaigns.org_id,
      tracking_id: campaign_stages.tracking_id,
    })
    .from(campaign_stages)
    .innerJoin(campaigns, sql`${campaigns.id} = ${campaign_stages.campaign_id}`)
    .where(inArray(campaign_stages.tracking_id, trackingIds));

  const ambiguous = new Set<string>();
  for (const r of rows) {
    const tid = r.tracking_id;
    if (!tid) continue;
    if (map.has(tid)) {
      ambiguous.add(tid); // same tracking_id in >1 org — drop it
      continue;
    }
    map.set(tid, {
      stageId: r.stage_id,
      campaignId: r.campaign_id,
      orgId: r.org_id,
    });
  }
  for (const tid of ambiguous) map.delete(tid);
  return map;
}

// Pull the rolling window from Keitaro, map each report row's sub_id_3 back to a
// CamMan stage, and idempotently UPSERT the per-stage daily aggregate. Never
// throws: a fetch failure returns degraded; a single bad row is counted and
// skipped so it can't abort the batch.
export async function pollKeitaro(
  database: Database,
  opts?: { windowDays?: number },
): Promise<KeitaroPollResult> {
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = new Date();
  const from = `${formatInCampaignTimezone(
    new Date(now.getTime() - (windowDays - 1) * 86_400_000),
    "yyyy-MM-dd",
  )} 00:00:00`;
  const to = formatInCampaignTimezone(now, "yyyy-MM-dd HH:mm:ss");
  const range = { from, to, timezone: CAMPAIGN_TIMEZONE };

  const report = await buildKeitaroReport(range);
  const base: KeitaroPollResult = {
    ok: false,
    degraded: true,
    range,
    fetched: 0,
    matched: 0,
    upserted: 0,
    unmatched: 0,
    errored: 0,
    unmatched_samples: [],
    error: null,
  };

  if (!report.ok) {
    return { ...base, error: report.error };
  }

  const rows = report.rows;
  // Distinct, non-empty sub_id_3 values to resolve in one round-trip.
  const trackingIds = [
    ...new Set(
      rows
        .map((r) => (typeof r.sub_id_3 === "string" ? r.sub_id_3.trim() : ""))
        .filter((s) => s.length > 0),
    ),
  ];
  const stageMap = await resolveStages(database, trackingIds);

  let matched = 0;
  let upserted = 0;
  let unmatched = 0;
  let errored = 0;
  const unmatchedSamples = new Set<string>();

  for (const row of rows as KeitaroReportRow[]) {
    const tid =
      typeof row.sub_id_3 === "string" ? row.sub_id_3.trim() : "";
    const statDate = extractDate(row.day);
    const stage = tid ? stageMap.get(tid) : undefined;

    if (!stage || !statDate) {
      unmatched++;
      if (tid && unmatchedSamples.size < 10) unmatchedSamples.add(tid);
      continue;
    }
    matched++;

    try {
      await database
        .insert(keitaro_stage_results)
        .values({
          org_id: stage.orgId,
          campaign_id: stage.campaignId,
          stage_id: stage.stageId,
          stage_tracking_id: tid,
          stat_date: statDate,
          raw_clicks: toInt(row.clicks),
          clean_clicks: toInt(row.campaign_unique_clicks),
          checkouts: toInt(row.leads),
          sales: toInt(row.sales),
          revenue: toNumericString(row.revenue),
          cost: toNumericString(row.cost),
          epc: toNumericString(row.epc),
        })
        .onConflictDoUpdate({
          target: [
            keitaro_stage_results.org_id,
            keitaro_stage_results.stage_id,
            keitaro_stage_results.stat_date,
          ],
          set: {
            stage_tracking_id: tid,
            raw_clicks: toInt(row.clicks),
            clean_clicks: toInt(row.campaign_unique_clicks),
            checkouts: toInt(row.leads),
            sales: toInt(row.sales),
            revenue: toNumericString(row.revenue),
            cost: toNumericString(row.cost),
            epc: toNumericString(row.epc),
            synced_at: sql`now()`,
          },
        });
      upserted++;
    } catch {
      errored++;
    }
  }

  return {
    ok: true,
    degraded: false,
    range,
    fetched: rows.length,
    matched,
    upserted,
    unmatched,
    errored,
    unmatched_samples: [...unmatchedSamples],
    error: null,
  };
}
