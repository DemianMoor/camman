import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_stages, campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import {
  parsePreset,
  resolveDashboardRange,
  type ResolvedDashboardRange,
} from "@/lib/dashboard-range";
import {
  stageEffectiveDate,
  stageHasResults,
  stageNotArchived,
} from "@/lib/dashboard-stages";
import { can } from "@/lib/permissions";
import {
  salesRevenueTotals,
  type AttributionRange,
} from "@/lib/reporting/attribution";

// Top-line counts for the dashboard's stat strip + activity context.
// All counters scoped to the user's org.
//
// Any stage that carries recorded results counts (see `stageHasResults` in
// lib/dashboard-stages.ts) — whether the results came from manual entry or a
// CSV import, and regardless of whether the stage was ever walked through the
// `sent` status. Results are attributed to the EFFECTIVE REPORT DATE
// (`stageEffectiveDate`: COALESCE(scheduled_at, sent_at, status_changed_at,
// created_at)) — so a stage scheduled for May 30 whose results are imported on
// Jun 1 counts toward May 30. Archived stages are excluded.
//
// Date range is selected via `preset` (+ optional `from`/`to` for custom).
// When `compare=true`, the same aggregates are also computed for the previous
// period so the UI can show deltas.

type StageTotals = {
  sent_in_range: number;
  success_in_range: number;
  failed_in_range: number;
  cancelled_in_range: number;
  sms_sent: number;
  delivered: number;
  opt_outs_added: number;
  clickers_added: number;
  scrubbed_added: number;
  bounced_added: number;
  total_spend: string;
  total_sales: number;
  total_revenue: string;
};

const EMPTY_TOTALS: StageTotals = {
  sent_in_range: 0,
  success_in_range: 0,
  failed_in_range: 0,
  cancelled_in_range: 0,
  sms_sent: 0,
  delivered: 0,
  opt_outs_added: 0,
  clickers_added: 0,
  scrubbed_added: 0,
  bounced_added: 0,
  total_spend: "0",
  total_sales: 0,
  total_revenue: "0",
};

// Aggregate stage results whose effective send date falls in [from, to).
async function aggregateStages(
  orgId: string,
  from: Date,
  to: Date,
): Promise<StageTotals> {
  const effective = stageEffectiveDate;
  const rows = await db
    .select({
      sent_in_range: drizzleSql<number>`count(*) filter (where ${campaign_stages.status} = 'sent')::int`,
      success_in_range: drizzleSql<number>`count(*) filter (where ${campaign_stages.status} = 'success')::int`,
      failed_in_range: drizzleSql<number>`count(*) filter (where ${campaign_stages.status} = 'failed')::int`,
      cancelled_in_range: drizzleSql<number>`count(*) filter (where ${campaign_stages.status} = 'cancelled')::int`,
      sms_sent: drizzleSql<number>`coalesce(sum(${campaign_stages.sms_count}), 0)::int`,
      delivered: drizzleSql<number>`coalesce(sum(${campaign_stages.delivered_count}), 0)::int`,
      opt_outs_added: drizzleSql<number>`coalesce(sum(${campaign_stages.opt_out_count}), 0)::int`,
      clickers_added: drizzleSql<number>`coalesce(sum(${campaign_stages.click_count}), 0)::int`,
      scrubbed_added: drizzleSql<number>`coalesce(sum(${campaign_stages.scrubbed_count}), 0)::int`,
      bounced_added: drizzleSql<number>`coalesce(sum(${campaign_stages.bounced_count}), 0)::int`,
      total_spend: drizzleSql<string>`coalesce(sum(${campaign_stages.total_cost}), 0)::numeric(12,4)::text`,
      // total_sales / total_revenue are NOT computed here. Unlike the counters
      // above (inherently send-day events), sales & revenue are attributed by
      // CONVERSION DATE — Keitaro stat_date, plus manual entry date — never the
      // stage's send day. They are filled in from salesRevenueTotals() in GET.
      // See lib/reporting/attribution.ts (ATTRIBUTION_BASIS).
    })
    .from(campaign_stages)
    .where(
      and(
        eq(campaign_stages.org_id, orgId),
        stageNotArchived,
        stageHasResults,
        drizzleSql`${effective} >= ${from.toISOString()} and ${effective} < ${to.toISOString()}`,
      ),
    );
  // Merge over EMPTY_TOTALS so total_sales / total_revenue (not selected above)
  // default to 0 / "0" before GET overwrites them with the attribution figures.
  return { ...EMPTY_TOTALS, ...(rows[0] ?? {}) };
}

// Map a resolved dashboard window to the attribution range. Sales/revenue split
// their date dimension: the Keitaro side filters stat_date on the ET day strings
// [startYmd, endExclYmd); the manual-ledger side filters created_at on the same
// window's UTC instants [from, to).
function toAttributionRange(
  orgId: string,
  w: { from: Date; to: Date; startYmd: string; endExclYmd: string },
): AttributionRange {
  return {
    orgId,
    statDateFrom: w.startYmd,
    statDateToExclusive: w.endExclYmd,
    manualFromUtc: w.from,
    manualToExclusiveUtc: w.to,
  };
}

// Count campaigns completed within [from, to).
async function countCompleted(
  orgId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const rows = await db
    .select({
      completed: drizzleSql<number>`count(*) filter (
        where ${campaigns.status} = 'completed'
          and ${campaigns.status_changed_at} >= ${from.toISOString()}
          and ${campaigns.status_changed_at} < ${to.toISOString()}
      )::int`,
    })
    .from(campaigns)
    .where(eq(campaigns.org_id, orgId));
  return rows[0]?.completed ?? 0;
}

// Shape totals into the API response block, deriving ROI.
function shapeTotals(t: StageTotals, completedInRange: number) {
  const totalSpend = Number(t.total_spend);
  const totalRevenue = Number(t.total_revenue);
  // ROI as a signed percentage: ((income - spend) / spend) * 100. Null when
  // there's no spend to divide by (avoids divide-by-zero / misleading values).
  // NOTE — mixed windows: revenue is conversion-dated (stat_date) while spend is
  // send-dated (conversions lag the send), so a single day's ROI compares
  // partially-different cohorts. This is acceptable: over any steady multi-day
  // period the lag washes out, and conversion-dating revenue is the deliberate
  // standard (lib/reporting/attribution.ts). Spend has no conversion date.
  const roi =
    totalSpend > 0 ? ((totalRevenue - totalSpend) / totalSpend) * 100 : null;
  return {
    campaigns: { completed_in_range: completedInRange },
    stages: {
      sent_in_range: t.sent_in_range,
      success_in_range: t.success_in_range,
      failed_in_range: t.failed_in_range,
      cancelled_in_range: t.cancelled_in_range,
    },
    totals: {
      sms_sent: t.sms_sent,
      delivered: t.delivered,
      opt_outs_added: t.opt_outs_added,
      clickers_added: t.clickers_added,
      scrubbed_added: t.scrubbed_added,
      bounced_added: t.bounced_added,
      total_spend: totalSpend,
      total_sales: t.total_sales,
      total_revenue: totalRevenue,
      roi,
    },
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const sp = req.nextUrl.searchParams;
  const preset = parsePreset(sp.get("preset"));
  const compare = sp.get("compare") === "true";
  const resolved = resolveDashboardRange(preset, {
    from: sp.get("from"),
    to: sp.get("to"),
  });
  if (!resolved.ok) {
    return apiError(400, resolved.error, API_ERROR_CODES.VALIDATION);
  }
  const range: ResolvedDashboardRange = resolved.range;

  // Campaign status counts are point-in-time (not period-bound).
  const statusCountsP = db
    .select({
      active: drizzleSql<number>`count(*) filter (where ${campaigns.status} = 'active')::int`,
      paused: drizzleSql<number>`count(*) filter (where ${campaigns.status} = 'paused')::int`,
      draft: drizzleSql<number>`count(*) filter (where ${campaigns.status} = 'draft')::int`,
    })
    .from(campaigns)
    .where(eq(campaigns.org_id, orgId));

  const [statusCounts, currentTotals, currentCompleted, currentAttr, prev] =
    await Promise.all([
      statusCountsP,
      aggregateStages(orgId, range.current.from, range.current.to),
      countCompleted(orgId, range.current.from, range.current.to),
      salesRevenueTotals(toAttributionRange(orgId, range.current)),
      compare
        ? Promise.all([
            aggregateStages(orgId, range.previous.from, range.previous.to),
            countCompleted(orgId, range.previous.from, range.previous.to),
            salesRevenueTotals(toAttributionRange(orgId, range.previous)),
          ])
        : Promise.resolve(null),
    ]);

  // Overlay conversion-dated sales & revenue onto the send-day counter totals.
  currentTotals.total_sales = currentAttr.sales;
  currentTotals.total_revenue = currentAttr.revenue;
  if (prev) {
    prev[0].total_sales = prev[2].sales;
    prev[0].total_revenue = prev[2].revenue;
  }

  const sc = statusCounts[0] ?? { active: 0, paused: 0, draft: 0 };
  const current = shapeTotals(currentTotals, currentCompleted);

  return NextResponse.json({
    range: {
      preset: range.preset,
      label: range.label,
      from: range.current.from.toISOString(),
      to: range.current.to.toISOString(),
    },
    compare,
    previousRange: compare
      ? {
          from: range.previous.from.toISOString(),
          to: range.previous.to.toISOString(),
        }
      : null,
    campaigns: {
      active: sc.active,
      paused: sc.paused,
      draft: sc.draft,
      completed_in_range: current.campaigns.completed_in_range,
    },
    stages: current.stages,
    totals: current.totals,
    previous: prev ? shapeTotals(prev[0], prev[1]) : null,
  });
}
