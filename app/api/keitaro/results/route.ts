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
  withoutEventBreakdown,
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

  // ⭐ AN EXPLICIT PROJECTION, NOT `db.select()`. A bare select expands to every
  // column the SCHEMA MIRROR names, which is not the same set as the columns this
  // handler uses — and not necessarily the same set the DEPLOYED DATABASE has.
  // db/schema.ts leads the migrations by design (CLAUDE.md §14: additive leads the
  // code), so between a deploy and its migration a bare select names columns that
  // do not exist yet and the endpoint answers 42703 for a column nothing here
  // reads. This list is exactly the funnel's input (KeitaroResultRowLike,
  // lib/keitaro/funnel.ts) plus the four fields the response body echoes, so the
  // handler's schema dependency is the one it actually has: `pending_revenue`
  // (0182) is named because addRowToFunnel reads it, while `events` and
  // `unmapped_conversions` (0185) are not named because nothing here reads them.
  //
  // ⭐ AND BECAUSE THEY ARE NOT SELECTED, THEY ARE NOT EMITTED. Every response
  // body below goes through withoutEventBreakdown(), which deletes `events`,
  // `unmapped` and `manual_topup` from the derived tally. Left in, they would
  // read `{}` / 0 — indistinguishable from "this campaign had no conversions of
  // any type" — because addRowToFunnel folds an absent column as an empty map.
  // An absent field and an empty map must not look the same.
  const rows = await db
    .select({
      stage_id: keitaro_stage_results.stage_id,
      stage_tracking_id: keitaro_stage_results.stage_tracking_id,
      stat_date: keitaro_stage_results.stat_date,
      synced_at: keitaro_stage_results.synced_at,
      visit_clicks_raw: keitaro_stage_results.visit_clicks_raw,
      visit_clicks_clean: keitaro_stage_results.visit_clicks_clean,
      redirect_clicks_raw: keitaro_stage_results.redirect_clicks_raw,
      redirect_clicks_clean: keitaro_stage_results.redirect_clicks_clean,
      raw_clicks: keitaro_stage_results.raw_clicks,
      clean_clicks: keitaro_stage_results.clean_clicks,
      sales: keitaro_stage_results.sales,
      revenue: keitaro_stage_results.revenue,
      pending_revenue: keitaro_stage_results.pending_revenue,
      cost: keitaro_stage_results.cost,
    })
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
    // TIME BASIS, stated explicitly rather than left to be inferred.
    //
    // This endpoint applies NO date filter: it selects every keitaro_stage_results
    // row for the campaign, and resolves counted clickers unbounded. So `totals`
    // and `stages` are LIFETIME figures — their `epc` is the lifetime EPC, and is
    // mirrored as `lifetime_epc` so a consumer never has to infer which basis it
    // is looking at.
    //
    // `rows` is different: one row per (stage, ET day), each divided by that
    // day's counted clickers. Those are PERIOD figures at day granularity, and
    // they do NOT sum to the stage total — counted clickers are deduplicated, so
    // a contact clicking on two days appears in two day-buckets but counts once
    // in the stage's lifetime figure.
    time_basis: { totals: "lifetime", stages: "lifetime", rows: "per_day" },
    totals: {
      ...withoutEventBreakdown(
        withFunnelDerived(
          campaignTally,
          denominatorFor(linkMode, clickersByCampaign.get(campaignId), campaignTally.visit_clicks_clean),
        ),
      ),
      lifetime_epc: withFunnelDerived(
        campaignTally,
        denominatorFor(linkMode, clickersByCampaign.get(campaignId), campaignTally.visit_clicks_clean),
      ).epc,
    },
    stages: [...perStage.values()]
      .sort((a, b) => a.stage_id - b.stage_id)
      .map((s) => ({
        stage_id: s.stage_id,
        stage_tracking_id: s.stage_tracking_id,
        ...withoutEventBreakdown(
          withFunnelDerived(
            s.tally,
            denominatorFor(linkMode, clickersByStage.get(s.stage_id), s.tally.visit_clicks_clean),
          ),
        ),
        lifetime_epc: withFunnelDerived(
          s.tally,
          denominatorFor(linkMode, clickersByStage.get(s.stage_id), s.tally.visit_clicks_clean),
        ).epc,
      })),
    rows: rows
      .map((r) => {
        const t = addRowToFunnel(emptyFunnel(), r);
        return {
          stage_id: r.stage_id,
          stage_tracking_id: r.stage_tracking_id,
          stat_date: r.stat_date,
          ...withoutEventBreakdown(
            withFunnelDerived(
              t,
              denominatorFor(
                linkMode,
                clickersByStageDay.get(`${r.stage_id}|${r.stat_date}`),
                t.visit_clicks_clean,
              ),
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
