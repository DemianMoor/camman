import { sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { can } from "@/lib/permissions";

// Compute the YYYY-MM-DD string for `date` in `timeZone` (Intl-based,
// no date-fns dependency — same approach as utcToCampaignLocalInput but
// just the date portion).
function formatDateInZone(date: Date, timeZone: string): string {
  // en-CA gives ISO-ish YYYY-MM-DD; using formatToParts to be explicit.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

// Per-day activity buckets for the dashboard chart. Bucketing happens in
// the campaign timezone (America/New_York) so a stage sent at 11pm ET on
// May 14 lands in May 14's bucket, not May 15.
//
// Approach: compute the date range in JS (today-in-ET back N days), pass
// the start date to SQL as a parameter, then aggregate by date_trunc on
// the AT TIME ZONE conversion. We post-process to fill in empty days —
// simpler than wrestling generate_series + timezone arithmetic in SQL.
export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const daysParam = req.nextUrl.searchParams.get("days");
  const days = daysParam ? Number(daysParam) : 7;
  if (!Number.isInteger(days) || days <= 0 || days > 30) {
    return apiError(
      400,
      "days must be an integer between 1 and 30",
      API_ERROR_CODES.VALIDATION,
      { field: "days" },
    );
  }

  // Build the list of YYYY-MM-DD bucket keys we need to return, oldest
  // first. We need each "day in ET" — derived from a UTC instant by
  // formatting in ET. Use noon UTC of each calendar day to dodge any
  // edge cases at midnight.
  const now = new Date();
  const todayEt = formatDateInZone(now, CAMPAIGN_TIMEZONE);
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    // Step back i ET-days by subtracting i*24h from "today at noon UTC".
    // The noon trick keeps us away from DST edges.
    const noonUtc = new Date(
      Date.UTC(
        Number(todayEt.slice(0, 4)),
        Number(todayEt.slice(5, 7)) - 1,
        Number(todayEt.slice(8, 10)),
        12,
        0,
        0,
      ),
    );
    noonUtc.setUTCDate(noonUtc.getUTCDate() - i);
    dayKeys.push(formatDateInZone(noonUtc, CAMPAIGN_TIMEZONE));
  }
  const earliestKey = dayKeys[0];

  // Earliest UTC instant we care about: midnight of earliestKey in ET.
  // Pass to SQL as an ISO string so we can compare to TIMESTAMPTZ columns.
  // Compute by interpreting `${earliestKey}T00:00` in ET → UTC via SQL,
  // simpler than reimplementing fromZonedTime here.
  const campaignRows = (await db.execute(drizzleSql`
    select
      to_char((created_at at time zone ${CAMPAIGN_TIMEZONE})::date, 'YYYY-MM-DD') as day,
      count(*)::int as count
    from campaigns
    where org_id = ${orgId}::uuid
      and created_at >= (${earliestKey} || ' 00:00')::timestamp at time zone ${CAMPAIGN_TIMEZONE}
    group by 1
  `)) as unknown as { day: string; count: number }[];

  const stageRows = (await db.execute(drizzleSql`
    select
      to_char((sent_at at time zone ${CAMPAIGN_TIMEZONE})::date, 'YYYY-MM-DD') as day,
      count(*)::int as stages_sent,
      coalesce(sum(sms_count), 0)::int as sms_count,
      coalesce(sum(total_cost), 0)::numeric(12,4)::text as cost,
      coalesce(sum(opt_out_count), 0)::int as opt_outs,
      coalesce(sum(click_count), 0)::int as clickers
    from campaign_stages
    where org_id = ${orgId}::uuid
      and sent_at is not null
      and sent_at >= (${earliestKey} || ' 00:00')::timestamp at time zone ${CAMPAIGN_TIMEZONE}
    group by 1
  `)) as unknown as {
    day: string;
    stages_sent: number;
    sms_count: number;
    cost: string;
    opt_outs: number;
    clickers: number;
  }[];

  const campaignsByDay = new Map(
    campaignRows.map((r) => [r.day, r.count] as const),
  );
  const stagesByDay = new Map(stageRows.map((r) => [r.day, r] as const));

  const result = dayKeys.map((day) => {
    const s = stagesByDay.get(day);
    return {
      date: day,
      campaigns_created: campaignsByDay.get(day) ?? 0,
      stages_sent: s?.stages_sent ?? 0,
      sms_count: s?.sms_count ?? 0,
      cost: s ? Number(s.cost) : 0,
      opt_outs: s?.opt_outs ?? 0,
      clickers: s?.clickers ?? 0,
    };
  });

  return NextResponse.json({ days: result });
}
