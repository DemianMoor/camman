import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import {
  getStageDimensionReports,
  type PerfMetrics,
  type PerfRow,
} from "@/lib/reporting/performance-report";
import { ATTRIBUTION_BASES, type AttributionBasis } from "@/lib/reporting/report-dimensions";

// All-time creative × offer rows behind GET /api/reports/performance
// dimension=creative range=lifetime — ranking the whole creative bank, which the
// 92-day live range cannot do. Stored in operator_rollups, refreshed hourly by
// /api/cron/refresh-creative-lifetime.
//
// ⚠️ ONE STAGE-METRICS PASS PER BASIS. The all-time funnel measured 13.7s
// (conversion_date) and 12.0s (send_date) on 2026-09-14; the creative rows AND
// the per-offer totals an offer_id filter needs are grouped from the same pass.
//
// The blob holds creative / offer ids, slugs, offer names and integers — no
// contact data.

export const CREATIVE_LIFETIME_ROLLUP_KEY = "performance_creative_lifetime";

export interface CreativeLifetimeBasis {
  rows: PerfRow[];
  totals: PerfMetrics;
  /** Per offer id: that offer's row in dimension=offer — the totals under offer_id. */
  offer_totals: Record<string, PerfMetrics>;
  refreshedAt: string | null;
  from: string;
  to: string;
}

export interface CreativeLifetimeSnapshot {
  version: 1;
  bases: Record<AttributionBasis, CreativeLifetimeBasis>;
}

// All time = the first ET day with a sent stage or a tracker row, through today.
async function lifetimeRange(orgId: string): Promise<{ from: string; to: string }> {
  const to = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const rows = (await db.execute(sql`
    SELECT to_char(least(
      (SELECT min((sent_at AT TIME ZONE 'America/New_York')::date)
       FROM campaign_stages WHERE org_id = ${orgId}::uuid AND sent_at IS NOT NULL),
      (SELECT min(stat_date) FROM keitaro_stage_results WHERE org_id = ${orgId}::uuid)
    ), 'YYYY-MM-DD') AS first_day
  `)) as unknown as { first_day: string | null }[];
  return { from: rows[0]?.first_day ?? to, to };
}

export async function computeCreativeLifetime(orgId: string): Promise<CreativeLifetimeSnapshot> {
  const { from, to } = await lifetimeRange(orgId);
  const bases = {} as Record<AttributionBasis, CreativeLifetimeBasis>;
  for (const attribution of ATTRIBUTION_BASES) {
    const [creative, offer] = await getStageDimensionReports(orgId, ["creative", "offer"], {
      from,
      to,
      providerPhoneId: null,
      attribution,
    });
    const offerTotals: Record<string, PerfMetrics> = {};
    for (const row of offer.rows) {
      if (row.key === "none") continue;
      const { key, label, ...metrics } = row;
      void key;
      void label;
      offerTotals[row.key] = metrics;
    }
    bases[attribution] = {
      rows: creative.rows,
      totals: creative.totals,
      offer_totals: offerTotals,
      refreshedAt: creative.refreshedAt,
      from,
      to,
    };
  }
  return { version: 1, bases };
}

/** Recompute and store the lifetime rows for one org. */
export async function refreshCreativeLifetime(orgId: string): Promise<{ durationMs: number }> {
  const startedAt = Date.now();
  const snapshot = await computeCreativeLifetime(orgId);
  const durationMs = Date.now() - startedAt;
  await db.execute(sql`
    INSERT INTO operator_rollups (org_id, rollup_key, data, computed_at, duration_ms, updated_at)
    VALUES (${orgId}::uuid, ${CREATIVE_LIFETIME_ROLLUP_KEY}, ${JSON.stringify(snapshot)}::jsonb,
            now(), ${durationMs}, now())
    ON CONFLICT (org_id, rollup_key) DO UPDATE
      SET data = EXCLUDED.data,
          computed_at = EXCLUDED.computed_at,
          duration_ms = EXCLUDED.duration_ms,
          updated_at = now()
  `);
  return { durationMs };
}

/** One basis of the stored snapshot; null until the first refresh. */
export async function readCreativeLifetime(
  orgId: string,
  basis: AttributionBasis,
): Promise<{ basis: CreativeLifetimeBasis; computedAt: string } | null> {
  const rows = (await db.execute(sql`
    SELECT data->'bases'->${basis}::text AS basis,
           to_char(computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS computed_at
    FROM operator_rollups
    WHERE org_id = ${orgId}::uuid AND rollup_key = ${CREATIVE_LIFETIME_ROLLUP_KEY}
      AND data IS NOT NULL AND computed_at IS NOT NULL
  `)) as unknown as { basis: CreativeLifetimeBasis | null; computed_at: string }[];
  const row = rows[0];
  return row?.basis ? { basis: row.basis, computedAt: row.computed_at } : null;
}
