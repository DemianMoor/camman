import { NextResponse, type NextRequest } from "next/server";

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { keitaro_stage_results } from "@/db/schema";
import { requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import {
  emptyFunnel,
  addRowToFunnel,
  withFunnelDerived,
  type FunnelTally,
} from "@/lib/keitaro/funnel";

// Read the stored Keitaro per-stage daily aggregates for one campaign, org-
// scoped. Returns the raw per-(stage, date) rows plus per-stage and campaign
// rollups with the Clickers → Offer Redirect → Sales funnel + derived rates.
// Read-only; this never triggers a poll.
//
// GET /api/keitaro/results?campaign_id=<id>
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "campaigns.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const campaignId = Number(req.nextUrl.searchParams.get("campaign_id"));
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return NextResponse.json(
      { error: "campaign_id is required" },
      { status: 400 },
    );
  }

  const rows = await db
    .select()
    .from(keitaro_stage_results)
    .where(
      and(
        eq(keitaro_stage_results.org_id, auth.orgId),
        eq(keitaro_stage_results.campaign_id, campaignId),
      ),
    );

  const campaignTally = emptyFunnel();
  const perStage = new Map<
    number,
    { stage_id: number; stage_tracking_id: string; tally: FunnelTally }
  >();

  for (const r of rows) {
    addRowToFunnel(campaignTally, r);

    let s = perStage.get(r.stage_id);
    if (!s) {
      s = {
        stage_id: r.stage_id,
        stage_tracking_id: r.stage_tracking_id,
        tally: emptyFunnel(),
      };
      perStage.set(r.stage_id, s);
    }
    addRowToFunnel(s.tally, r);
  }

  return NextResponse.json({
    campaign_id: campaignId,
    totals: withFunnelDerived(campaignTally),
    stages: [...perStage.values()]
      .sort((a, b) => a.stage_id - b.stage_id)
      .map((s) => ({
        stage_id: s.stage_id,
        stage_tracking_id: s.stage_tracking_id,
        ...withFunnelDerived(s.tally),
      })),
    rows: rows
      .map((r) => {
        const t = addRowToFunnel(emptyFunnel(), r);
        return {
          stage_id: r.stage_id,
          stage_tracking_id: r.stage_tracking_id,
          stat_date: r.stat_date,
          ...withFunnelDerived(t),
          synced_at: r.synced_at,
        };
      })
      .sort((a, b) =>
        a.stat_date < b.stat_date ? 1 : a.stat_date > b.stat_date ? -1 : 0,
      ),
  });
}
