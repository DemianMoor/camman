import { NextResponse, type NextRequest } from "next/server";

import { and, eq, sql } from "drizzle-orm";

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
import {
  denominatorFor,
  getCountedClickers,
  getCountedClickersByStageDay,
} from "@/lib/reporting/counted-clickers";

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

  // EPC denominator: counted clickers, the same source every other surface uses.
  const [clickersByStage, clickersByCampaign, clickersByStageDay, campaignRow] =
    await Promise.all([
      getCountedClickers(db, auth.orgId, "stage"),
      getCountedClickers(db, auth.orgId, "campaign"),
      getCountedClickersByStageDay(db, auth.orgId),
      db.execute(
        sql`SELECT link_mode FROM campaigns WHERE id = ${campaignId} AND org_id = ${auth.orgId}::uuid`,
      ) as unknown as Promise<{ link_mode: string }[]>,
    ]);
  const linkMode = (await campaignRow)[0]?.link_mode ?? "manual";

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
    totals: withFunnelDerived(
      campaignTally,
      denominatorFor(linkMode, clickersByCampaign.get(campaignId), campaignTally.visit_clicks_clean),
    ),
    stages: [...perStage.values()]
      .sort((a, b) => a.stage_id - b.stage_id)
      .map((s) => ({
        stage_id: s.stage_id,
        stage_tracking_id: s.stage_tracking_id,
        ...withFunnelDerived(
          s.tally,
          denominatorFor(linkMode, clickersByStage.get(s.stage_id), s.tally.visit_clicks_clean),
        ),
      })),
    rows: rows
      .map((r) => {
        const t = addRowToFunnel(emptyFunnel(), r);
        return {
          stage_id: r.stage_id,
          stage_tracking_id: r.stage_tracking_id,
          stat_date: r.stat_date,
          ...withFunnelDerived(
            t,
            denominatorFor(
              linkMode,
              clickersByStageDay.get(`${r.stage_id}|${r.stat_date}`),
              t.visit_clicks_clean,
            ),
          ),
          synced_at: r.synced_at,
        };
      })
      .sort((a, b) =>
        a.stat_date < b.stat_date ? 1 : a.stat_date > b.stat_date ? -1 : 0,
      ),
  });
}
