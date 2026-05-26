import { and, between, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_stages, campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// Top-line counts for the dashboard's stat strip + activity context.
// All counters scoped to the user's org. Default range is the last 7 days
// (rolling — today inclusive).
export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const sp = req.nextUrl.searchParams;
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromParam = sp.get("from");
  const toParam = sp.get("to");
  const from = fromParam ? new Date(fromParam) : defaultFrom;
  const to = toParam ? new Date(toParam) : now;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return apiError(400, "Invalid date range", API_ERROR_CODES.VALIDATION);
  }

  // Two independent queries: campaign status counts (no date filter) +
  // status completed in range, plus stage-level aggregates within range.
  const [campaignCounts, stageAggregates] = await Promise.all([
    db
      .select({
        active: drizzleSql<number>`count(*) filter (where ${campaigns.status} = 'active')::int`,
        paused: drizzleSql<number>`count(*) filter (where ${campaigns.status} = 'paused')::int`,
        draft: drizzleSql<number>`count(*) filter (where ${campaigns.status} = 'draft')::int`,
        completed_in_range: drizzleSql<number>`count(*) filter (
          where ${campaigns.status} = 'completed'
            and ${campaigns.status_changed_at} between ${from.toISOString()} and ${to.toISOString()}
        )::int`,
      })
      .from(campaigns)
      .where(eq(campaigns.org_id, orgId)),
    db
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
      })
      .from(campaign_stages)
      .where(
        and(
          eq(campaign_stages.org_id, orgId),
          between(campaign_stages.sent_at, from, to),
        ),
      ),
  ]);

  const c = campaignCounts[0] ?? {
    active: 0,
    paused: 0,
    draft: 0,
    completed_in_range: 0,
  };
  const s = stageAggregates[0] ?? {
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
  };

  return NextResponse.json({
    range: { from: from.toISOString(), to: to.toISOString() },
    campaigns: {
      active: c.active,
      paused: c.paused,
      draft: c.draft,
      completed_in_range: c.completed_in_range,
    },
    stages: {
      sent_in_range: s.sent_in_range,
      success_in_range: s.success_in_range,
      failed_in_range: s.failed_in_range,
      cancelled_in_range: s.cancelled_in_range,
    },
    totals: {
      sms_sent: s.sms_sent,
      delivered: s.delivered,
      opt_outs_added: s.opt_outs_added,
      clickers_added: s.clickers_added,
      scrubbed_added: s.scrubbed_added,
      bounced_added: s.bounced_added,
      total_spend: Number(s.total_spend),
    },
  });
}
