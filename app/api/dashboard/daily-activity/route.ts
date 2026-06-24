import { sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import {
  enumerateDays,
  parsePreset,
  resolveDashboardRange,
} from "@/lib/dashboard-range";
import {
  stageEffectiveDate,
  stageHasResults,
  stageNotArchived,
} from "@/lib/dashboard-stages";
import { can } from "@/lib/permissions";

// Per-day activity buckets for the dashboard charts. Bucketing happens in the
// campaign timezone (America/New_York) so a stage with an effective report date
// of 11pm ET on May 14 lands in May 14's bucket, not May 15.
//
// Stages are bucketed by their EFFECTIVE REPORT DATE (`stageEffectiveDate`) and
// included whenever they carry recorded results (`stageHasResults`), matching
// the stats endpoint. The window comes from the same preset/custom range params.
export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const sp = req.nextUrl.searchParams;
  const preset = parsePreset(sp.get("preset"));
  const resolved = resolveDashboardRange(preset, {
    from: sp.get("from"),
    to: sp.get("to"),
  });
  if (!resolved.ok) {
    return apiError(400, resolved.error, API_ERROR_CODES.VALIDATION, {
      field: "range",
    });
  }
  const { startYmd, endExclYmd, from, to } = resolved.range.current;
  const dayKeys = enumerateDays(startYmd, endExclYmd);

  // Aggregate by the ET calendar day of the effective send date. Filter on
  // the same effective expression so the bucket and the window agree.
  const stageRows = (await db.execute(drizzleSql`
    select
      to_char((${stageEffectiveDate} at time zone ${CAMPAIGN_TIMEZONE})::date, 'YYYY-MM-DD') as day,
      count(*)::int as stages_sent,
      coalesce(sum(sms_count), 0)::int as sms_count,
      coalesce(sum(total_cost), 0)::numeric(12,4)::text as cost,
      -- Revenue = SUM of real per-conversion payout from Keitaro
      -- (keitaro_stage_results.revenue), never sales × the offer's current CPA
      -- (a mid-flight CPA change would retro-misprice prior sales). Each stage's
      -- full Keitaro revenue is attributed to that stage's effective day.
      coalesce(sum(
        (SELECT coalesce(sum(ksr.revenue), 0)
           FROM keitaro_stage_results ksr
          WHERE ksr.stage_id = campaign_stages.id)
      ), 0)::numeric(12,4)::text as revenue,
      coalesce(sum(sales_count), 0)::int as sales,
      coalesce(sum(opt_out_count), 0)::int as opt_outs,
      coalesce(sum(click_count), 0)::int as clickers
    from campaign_stages
    where org_id = ${orgId}::uuid
      and ${stageNotArchived}
      and ${stageHasResults}
      and ${stageEffectiveDate} >= ${from.toISOString()}
      and ${stageEffectiveDate} < ${to.toISOString()}
    group by 1
  `)) as unknown as {
    day: string;
    stages_sent: number;
    sms_count: number;
    cost: string;
    revenue: string;
    sales: number;
    opt_outs: number;
    clickers: number;
  }[];

  const stagesByDay = new Map(stageRows.map((r) => [r.day, r] as const));

  const result = dayKeys.map((day) => {
    const s = stagesByDay.get(day);
    return {
      date: day,
      stages_sent: s?.stages_sent ?? 0,
      sms_count: s?.sms_count ?? 0,
      cost: s ? Number(s.cost) : 0,
      revenue: s ? Number(s.revenue) : 0,
      sales: s?.sales ?? 0,
      opt_outs: s?.opt_outs ?? 0,
      clickers: s?.clickers ?? 0,
    };
  });

  return NextResponse.json({ days: result });
}
