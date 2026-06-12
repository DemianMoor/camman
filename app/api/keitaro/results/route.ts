import { NextResponse, type NextRequest } from "next/server";

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { keitaro_stage_results } from "@/db/schema";
import { requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";

// Read the stored Keitaro per-stage daily aggregates for one campaign, org-
// scoped. Returns the raw per-(stage, date) rows plus per-stage and campaign
// rollups with derived rates. Read-only; this never triggers a poll.
//
// GET /api/keitaro/results?campaign_id=<id>
export const dynamic = "force-dynamic";

interface Tally {
  raw_clicks: number;
  clean_clicks: number;
  checkouts: number;
  sales: number;
  revenue: number;
  cost: number;
}

function emptyTally(): Tally {
  return {
    raw_clicks: 0,
    clean_clicks: 0,
    checkouts: 0,
    sales: 0,
    revenue: 0,
    cost: 0,
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

// Derived reporting metrics from a tally (see the brief's naming map). EPC is
// revenue per raw click; CTR is clean/raw; checkout & sales rates chain down.
function withDerived(t: Tally) {
  return {
    ...t,
    ctr: rate(t.clean_clicks, t.raw_clicks),
    checkout_rate: rate(t.checkouts, t.clean_clicks),
    sales_cr: rate(t.sales, t.checkouts),
    epc: rate(t.revenue, t.raw_clicks),
  };
}

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

  const campaignTally = emptyTally();
  const perStage = new Map<
    number,
    { stage_id: number; stage_tracking_id: string; tally: Tally }
  >();

  for (const r of rows) {
    const add = (t: Tally) => {
      t.raw_clicks += r.raw_clicks;
      t.clean_clicks += r.clean_clicks;
      t.checkouts += r.checkouts;
      t.sales += r.sales;
      t.revenue += Number(r.revenue);
      t.cost += Number(r.cost);
    };
    add(campaignTally);

    let s = perStage.get(r.stage_id);
    if (!s) {
      s = {
        stage_id: r.stage_id,
        stage_tracking_id: r.stage_tracking_id,
        tally: emptyTally(),
      };
      perStage.set(r.stage_id, s);
    }
    add(s.tally);
  }

  return NextResponse.json({
    campaign_id: campaignId,
    totals: withDerived(campaignTally),
    stages: [...perStage.values()]
      .sort((a, b) => a.stage_id - b.stage_id)
      .map((s) => ({
        stage_id: s.stage_id,
        stage_tracking_id: s.stage_tracking_id,
        ...withDerived(s.tally),
      })),
    rows: rows
      .map((r) => ({
        stage_id: r.stage_id,
        stage_tracking_id: r.stage_tracking_id,
        stat_date: r.stat_date,
        raw_clicks: r.raw_clicks,
        clean_clicks: r.clean_clicks,
        checkouts: r.checkouts,
        sales: r.sales,
        revenue: Number(r.revenue),
        cost: Number(r.cost),
        epc: Number(r.epc),
        synced_at: r.synced_at,
      }))
      .sort((a, b) =>
        a.stat_date < b.stat_date ? 1 : a.stat_date > b.stat_date ? -1 : 0,
      ),
  });
}
