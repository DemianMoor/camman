import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

import { db } from "@/db/client";
import {
  campaign_stages,
  campaigns,
  keitaro_stage_results,
  opt_out_attributions,
  provider_phones,
  stage_sends,
} from "@/db/schema";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { addRowToFunnel, emptyFunnel, type FunnelTally } from "@/lib/keitaro/funnel";
import {
  lifetimeManualSalesByStage,
  manualSalesByStageInRange,
} from "@/lib/reporting/attribution";
import {
  getCountedClickers,
  getTotalCountedClickers,
  type CountedClickerBounds,
} from "@/lib/reporting/counted-clickers";
import type { AttributionBasis } from "@/lib/reporting/report-dimensions";

// SINGLE SOURCE OF TRUTH for the per-stage Clickers → Offer Redirect → Sales
// funnel over an ET date range. Extracted from app/api/keitaro/reports/route.ts
// (the "Overview" tab) so the Overview tab AND the by-number/offer/sequence/group
// performance reports compute from the EXACT same per-stage numbers and can never
// drift. Sales/revenue conversion-dated (stat_date); sends/cost/opt-outs by their
// own event/send time in range. See lib/reporting/attribution.ts for the basis.
//
// The only addition over the original route is the grouping keys the new reports
// need (provider_phone_id, offer_id, brand_id) — the metric math is identical.

export interface StageMetrics {
  stage_id: number;
  campaign_id: number;
  campaign_name: string;
  link_mode: string;
  stage_number: number | null;
  stage_label: string | null;
  stage_tracking_id: string;
  // Send time, carried so the Overview's clickers fallback can require a stage
  // to be MATURE before reading zero Keitaro visits as a tracking gap
  // (lib/reporting/tracking-gap.ts). Null for a stage with no send stamp.
  sent_at: Date | null;
  // Grouping keys for the performance reports.
  provider_phone_id: number | null;
  // The stage's send number, resolved for display (Overview campaign cell).
  phone_number: string | null;
  phone_number_type: string | null;
  offer_id: number | null;
  // The stage's creative (campaign_stages.creative_id) — the creative dimension's key.
  creative_id: number | null;
  brand_id: number | null;
  // Computed metrics (identical to Overview).
  opt_outs: number;
  total_sent: number;
  // Per-recipient offer reach: stage_sends.offer_reached_at dated by REACH day
  // in range. null for manual-mode stages — they mint no links, so reach is
  // unknowable, and null must never read as a real zero.
  reached: number | null;
  tally: FunnelTally; // visit_clicks_clean = clickers, redirect_clicks_clean = offer redirect, sales, revenue, cost
  /**
   * How much of `tally.sales` came from the MANUAL tally rather than the tracker
   * (lib/reporting/attribution.ts). The per-event breakdown in `tally.events`
   * counts tracker ledger events only, so:
   *     Σ tally.events[t].n over is_purchase types  +  manual_topup  =  tally.sales
   * Carried so the UI can say so instead of showing columns that do not foot.
   */
  manual_topup: number;
}

// The EPC denominator, in both time bases, at both grains the reports render.
// Fetched here rather than in each route so Overview and the by-X performance
// reports cannot drift — the same reason the funnel math lives here.
//
// PERIOD is bounded by the requested ET range on the CLICK's date; LIFETIME
// ignores the range entirely. Neither is derivable from the other: counted
// clickers are deduplicated, so they are not additive over time (one contact
// clicking on two days is one lifetime clicker, not two). Both are therefore
// queried, never summed. Lifetime revenue is likewise fetched unbounded.
export interface ClickerDenominators {
  periodByCampaign: Map<number, number>;
  periodByStage: Map<number, number>;
  periodTotal: number;
  lifetimeByCampaign: Map<number, number>;
  lifetimeByStage: Map<number, number>;
  lifetimeTotal: number;
  lifetimeRevenueByCampaign: Map<number, number>;
  lifetimeRevenueByStage: Map<number, number>;
  lifetimeRevenueTotal: number;
}

export interface StageMetricsResult {
  stages: StageMetrics[];
  // Grand totals, matching the Overview totals card exactly.
  grand: FunnelTally;
  grandOptOuts: number;
  grandTotalSent: number;
  clickers: ClickerDenominators;
}

function addOneDay(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export async function getStageMetricsInRange(
  orgId: string,
  from: string,
  to: string,
  opts: { attribution?: AttributionBasis } = {},
): Promise<StageMetricsResult> {
  // conversion_date (the default, and the only basis before 2026-09-14) = each
  // metric on its own event day within the range. send_date = the COHORT of
  // stages sent in range, with everything they have produced to date: every
  // stat_date, every attribution, every reach, lifetime clickers.
  const sendDate = opts.attribution === "send_date";
  const byStage = new Map<number, StageMetrics>();
  const grand = emptyFunnel();

  const fromUtc = fromZonedTime(`${from}T00:00:00`, CAMPAIGN_TIMEZONE);
  const toExclusiveUtc = fromZonedTime(`${addOneDay(to)}T00:00:00`, CAMPAIGN_TIMEZONE);

  // Stages SENT in range. Under conversion_date they seed stages Keitaro has no
  // results row for (zero-click or unpolled) so their send Cost + Total Sent
  // aren't silently dropped; under send_date they ARE the stage set.
  const sentStageRows = await db
    .select({
      stage_id: campaign_stages.id,
      campaign_id: campaign_stages.campaign_id,
      campaign_name: campaigns.name,
      link_mode: campaigns.link_mode,
      offer_id: campaigns.offer_id,
      brand_id: campaigns.brand_id,
      creative_id: campaign_stages.creative_id,
      stage_number: campaign_stages.stage_number,
      stage_label: campaign_stages.label,
      provider_phone_id: campaign_stages.provider_phone_id,
      phone_number: provider_phones.phone_number,
      phone_number_type: provider_phones.number_type,
      stage_tracking_id: campaign_stages.tracking_id,
      stage_sent_at: campaign_stages.sent_at,
      stage_sms_count: campaign_stages.sms_count,
      stage_total_cost: campaign_stages.total_cost,
    })
    .from(campaign_stages)
    .innerJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
    .leftJoin(provider_phones, eq(provider_phones.id, campaign_stages.provider_phone_id))
    .where(
      and(
        eq(campaign_stages.org_id, orgId),
        isNull(campaign_stages.archived_at),
        gte(campaign_stages.sent_at, fromUtc),
        lt(campaign_stages.sent_at, toExclusiveUtc),
      ),
    );
  const cohortIds = sentStageRows.map((r) => r.stage_id);

  const rows =
    sendDate && cohortIds.length === 0
      ? []
      : await db
          .select({
            stage_id: keitaro_stage_results.stage_id,
            campaign_id: keitaro_stage_results.campaign_id,
            stage_tracking_id: keitaro_stage_results.stage_tracking_id,
            campaign_name: campaigns.name,
            link_mode: campaigns.link_mode,
            offer_id: campaigns.offer_id,
            brand_id: campaigns.brand_id,
            creative_id: campaign_stages.creative_id,
            stage_number: campaign_stages.stage_number,
            stage_label: campaign_stages.label,
            provider_phone_id: campaign_stages.provider_phone_id,
            phone_number: provider_phones.phone_number,
            phone_number_type: provider_phones.number_type,
            stage_sent_at: campaign_stages.sent_at,
            stage_sms_count: campaign_stages.sms_count,
            stage_total_cost: campaign_stages.total_cost,
            visit_clicks_raw: keitaro_stage_results.visit_clicks_raw,
            visit_clicks_clean: keitaro_stage_results.visit_clicks_clean,
            redirect_clicks_raw: keitaro_stage_results.redirect_clicks_raw,
            redirect_clicks_clean: keitaro_stage_results.redirect_clicks_clean,
            raw_clicks: keitaro_stage_results.raw_clicks,
            clean_clicks: keitaro_stage_results.clean_clicks,
            sales: keitaro_stage_results.sales,
            revenue: keitaro_stage_results.revenue,
            pending_revenue: keitaro_stage_results.pending_revenue,
            events: keitaro_stage_results.events,
            unmapped_conversions: keitaro_stage_results.unmapped_conversions,
            cost: keitaro_stage_results.cost,
          })
          .from(keitaro_stage_results)
          .innerJoin(campaigns, eq(campaigns.id, keitaro_stage_results.campaign_id))
          .leftJoin(campaign_stages, eq(campaign_stages.id, keitaro_stage_results.stage_id))
          .leftJoin(provider_phones, eq(provider_phones.id, campaign_stages.provider_phone_id))
          .where(
            and(
              eq(keitaro_stage_results.org_id, orgId),
              ...(sendDate
                ? [inArray(keitaro_stage_results.stage_id, cohortIds)]
                : [
                    gte(keitaro_stage_results.stat_date, from),
                    lte(keitaro_stage_results.stat_date, to),
                  ]),
            ),
          );

  // Carry per-stage send anchor + lifetime SMS count for manual attribution.
  const anchor = new Map<number, { sentAt: Date | null; smsCount: number; totalCost: number }>();

  for (const r of rows) {
    addRowToFunnel(grand, r);
    let acc = byStage.get(r.stage_id);
    if (!acc) {
      acc = {
        stage_id: r.stage_id,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name ?? "(unnamed)",
        link_mode: r.link_mode ?? "manual",
        stage_number: r.stage_number,
        stage_label: r.stage_label,
        stage_tracking_id: r.stage_tracking_id,
        sent_at: r.stage_sent_at ?? null,
        provider_phone_id: r.provider_phone_id ?? null,
        phone_number: r.phone_number ?? null,
        phone_number_type: r.phone_number_type ?? null,
        offer_id: r.offer_id ?? null,
        brand_id: r.brand_id ?? null,
        creative_id: r.creative_id ?? null,
        opt_outs: 0,
        total_sent: 0,
        reached: null,
        tally: emptyFunnel(),
        manual_topup: 0,
      };
      byStage.set(r.stage_id, acc);
      anchor.set(r.stage_id, {
        sentAt: r.stage_sent_at,
        smsCount: r.stage_sms_count ?? 0,
        totalCost: Number(r.stage_total_cost ?? 0),
      });
    }
    addRowToFunnel(acc.tally, r);
  }

  // Seed the in-range sent stages that have no Keitaro row (see sentStageRows).
  for (const r of sentStageRows) {
    if (byStage.has(r.stage_id)) continue;
    byStage.set(r.stage_id, {
      stage_id: r.stage_id,
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name ?? "(unnamed)",
      link_mode: r.link_mode ?? "manual",
      stage_number: r.stage_number,
      stage_label: r.stage_label,
      stage_tracking_id: r.stage_tracking_id ?? "",
      sent_at: r.stage_sent_at ?? null,
      provider_phone_id: r.provider_phone_id ?? null,
      phone_number: r.phone_number ?? null,
      phone_number_type: r.phone_number_type ?? null,
      offer_id: r.offer_id ?? null,
      brand_id: r.brand_id ?? null,
      creative_id: r.creative_id ?? null,
      opt_outs: 0,
      total_sent: 0,
      reached: null,
      tally: emptyFunnel(),
      manual_topup: 0,
    });
    anchor.set(r.stage_id, {
      sentAt: r.stage_sent_at,
      smsCount: r.stage_sms_count ?? 0,
      totalCost: Number(r.stage_total_cost ?? 0),
    });
  }

  const stageIds = [...byStage.keys()];
  let grandOptOuts = 0;
  let grandTotalSent = 0;
  let grandSalesTopup = 0;
  let grandTotalCost = 0;
  if (stageIds.length > 0) {
    // Under send_date every per-stage window below is dropped: a cohort stage's
    // metrics are everything it has produced to date, whenever it happened.
    const [optOutRows, sentRows, manualSalesByStage, reachedRows] = await Promise.all([
      db
        .select({ stage_id: opt_out_attributions.stage_id, n: sql<number>`count(*)::int` })
        .from(opt_out_attributions)
        .where(
          and(
            eq(opt_out_attributions.org_id, orgId),
            inArray(opt_out_attributions.stage_id, stageIds),
            ...(sendDate
              ? []
              : [
                  gte(opt_out_attributions.created_at, fromUtc),
                  lt(opt_out_attributions.created_at, toExclusiveUtc),
                ]),
          ),
        )
        .groupBy(opt_out_attributions.stage_id),
      db
        .select({ stage_id: stage_sends.stage_id, sent: sql<number>`count(*)::int` })
        .from(stage_sends)
        .where(
          and(
            eq(stage_sends.org_id, orgId),
            eq(stage_sends.status, "sent"),
            inArray(stage_sends.stage_id, stageIds),
            ...(sendDate
              ? []
              : [gte(stage_sends.sent_at, fromUtc), lt(stage_sends.sent_at, toExclusiveUtc)]),
          ),
        )
        .groupBy(stage_sends.stage_id),
      sendDate
        ? lifetimeManualSalesByStage({ orgId, stageIds })
        : manualSalesByStageInRange({ orgId, fromUtc, toExclusiveUtc }),
      // Per-recipient offer reach (operator-API grading): by REACH day under
      // conversion_date, ever-reached under send_date. Counted for the stages
      // already in the set: a reach is an offer click, which Keitaro books the
      // same day, so a reached stage already has a row here (measured 0
      // reach-only stages on 1-day and 7-day ranges).
      db
        .select({ stage_id: stage_sends.stage_id, n: sql<number>`count(*)::int` })
        .from(stage_sends)
        .where(
          and(
            eq(stage_sends.org_id, orgId),
            inArray(stage_sends.stage_id, stageIds),
            ...(sendDate
              ? [isNotNull(stage_sends.offer_reached_at)]
              : [
                  gte(stage_sends.offer_reached_at, fromUtc),
                  lt(stage_sends.offer_reached_at, toExclusiveUtc),
                ]),
          ),
        )
        .groupBy(stage_sends.stage_id),
    ]);
    const optOutsByStage = new Map(optOutRows.map((o) => [o.stage_id, Number(o.n)]));
    const sentByStage = new Map(sentRows.map((s) => [s.stage_id, Number(s.sent)]));
    const reachedByStage = new Map(reachedRows.map((r) => [r.stage_id, Number(r.n)]));
    const sentInRange = (sentAt: Date | null): boolean =>
      sentAt != null && sentAt >= fromUtc && sentAt < toExclusiveUtc;

    for (const acc of byStage.values()) {
      const a = anchor.get(acc.stage_id)!;
      acc.opt_outs = optOutsByStage.get(acc.stage_id) ?? 0;
      acc.reached = acc.link_mode === "tracked" ? reachedByStage.get(acc.stage_id) ?? 0 : null;
      // A send_date cohort stage is in range by definition.
      const inRange = sendDate || sentInRange(a.sentAt);
      acc.total_sent =
        acc.link_mode === "tracked"
          ? sentByStage.get(acc.stage_id) ?? 0
          : inRange
            ? a.smsCount
            : 0;
      const manualInRange = manualSalesByStage.get(acc.stage_id) ?? 0;
      const manual = Math.max(0, manualInRange - acc.tally.sales);
      acc.tally.sales += manual;
      // Recorded rather than discarded: per-event columns count TRACKER events
      // only, so this is exactly the gap between Σ (is_purchase) n and `sales`,
      // and a footing bar (or a screen that claims the columns explain Sales)
      // needs it. It was summed into grandSalesTopup and thrown away before.
      acc.manual_topup = manual;
      acc.tally.cost = inRange ? a.totalCost : 0;
      grandOptOuts += acc.opt_outs;
      grandTotalSent += acc.total_sent;
      grandSalesTopup += manual;
      grandTotalCost += acc.tally.cost;
    }
  }
  grand.sales += grandSalesTopup;
  grand.cost = grandTotalCost;

  const clickers = await getClickerDenominators(
    orgId,
    sendDate ? { stageIds: cohortIds } : { fromUtc, toExclusiveUtc },
  );

  return { stages: [...byStage.values()], grand, grandOptOuts, grandTotalSent, clickers };
}

// Both time bases, both grains, plus unbounded revenue for the lifetime figure.
// `period` is the ET date window (conversion_date) or exactly the cohort's stages
// with no date bound (send_date).
async function getClickerDenominators(
  orgId: string,
  period: CountedClickerBounds,
): Promise<ClickerDenominators> {
  const [
    periodByCampaign,
    periodByStage,
    periodTotal,
    lifetimeByCampaign,
    lifetimeByStage,
    lifetimeTotal,
    revenueRows,
  ] = await Promise.all([
    getCountedClickers(db, orgId, "campaign", period),
    getCountedClickers(db, orgId, "stage", period),
    getTotalCountedClickers(db, orgId, period),
    getCountedClickers(db, orgId, "campaign"),
    getCountedClickers(db, orgId, "stage"),
    getTotalCountedClickers(db, orgId),
    db.execute(sql`
      SELECT campaign_id, stage_id, sum(revenue)::float8 AS revenue
      FROM keitaro_stage_results WHERE org_id = ${orgId}::uuid
      GROUP BY 1, 2
    `) as unknown as Promise<{ campaign_id: number; stage_id: number; revenue: number }[]>,
  ]);

  const lifetimeRevenueByCampaign = new Map<number, number>();
  const lifetimeRevenueByStage = new Map<number, number>();
  let lifetimeRevenueTotal = 0;
  for (const r of await revenueRows) {
    const rev = Number(r.revenue) || 0;
    lifetimeRevenueByCampaign.set(
      Number(r.campaign_id),
      (lifetimeRevenueByCampaign.get(Number(r.campaign_id)) ?? 0) + rev,
    );
    lifetimeRevenueByStage.set(
      Number(r.stage_id),
      (lifetimeRevenueByStage.get(Number(r.stage_id)) ?? 0) + rev,
    );
    lifetimeRevenueTotal += rev;
  }

  return {
    periodByCampaign,
    periodByStage,
    periodTotal,
    lifetimeByCampaign,
    lifetimeByStage,
    lifetimeTotal,
    lifetimeRevenueByCampaign,
    lifetimeRevenueByStage,
    lifetimeRevenueTotal,
  };
}
