import { NextResponse, type NextRequest } from "next/server";

import { and, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

import { db } from "@/db/client";
import {
  campaign_stages,
  campaigns,
  keitaro_stage_results,
  opt_out_attributions,
  stage_sends,
} from "@/db/schema";
import { requireApiMembership } from "@/lib/api/helpers";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import {
  addRowToFunnel,
  emptyFunnel,
  mergeFunnel,
  withFunnelDerived,
  type FunnelTally,
} from "@/lib/keitaro/funnel";
import { can } from "@/lib/permissions";
import { manualSalesByStageInRange } from "@/lib/reporting/attribution";

// Cross-campaign Keitaro reports: per-stage Clickers → Offer Redirect → Sales
// funnel aggregated over a date range (ET), with resolved CamMan campaign + stage
// names. Org-scoped, read-only. Powers the /reports page. Never triggers a poll.
//
// GET /api/keitaro/reports?from=YYYY-MM-DD&to=YYYY-MM-DD&search=&page=&pageSize=&sortBy=&sortDir=
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;

// Metrics the table can sort by — maps to fields on the derived funnel row.
const SORTABLE = new Set([
  "campaign_name",
  "clickers",
  "offer_redirect",
  "redirect_rate",
  "sales",
  "sales_cr",
  "revenue",
  "cost",
  "epc",
  "profit",
  "opt_outs",
  "total_sent",
  "opt_out_rate",
  "click_rate",
]);

// A fraction of total sent (rendered as a % client-side, like redirect_rate).
// 0 when nothing was sent — avoids divide-by-zero. Used for both the opt-out
// rate and the click-through rate (CR = clickers / total_sent).
function rateOfSent(numerator: number, totalSent: number): number {
  return totalSent > 0 ? numerator / totalSent : 0;
}

// Next calendar day for a YYYY-MM-DD string (date-only UTC arithmetic — no time
// component, so DST never enters into it). Used to build an exclusive upper bound.
function addOneDay(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "campaigns.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const todayEt = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const sevenDaysAgoEt = formatInCampaignTimezone(
    new Date(Date.now() - 6 * 86_400_000),
    "yyyy-MM-dd",
  );

  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  const from = fromRaw && DATE_RE.test(fromRaw) ? fromRaw : sevenDaysAgoEt;
  const to = toRaw && DATE_RE.test(toRaw) ? toRaw : todayEt;
  if (from > to) {
    return NextResponse.json(
      { error: "`from` must be on or before `to`" },
      { status: 400 },
    );
  }
  // Bound the scan: a runaway range would pull every stored row.
  const spanDays =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
    86_400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    return NextResponse.json(
      { error: `Date range cannot exceed ${MAX_RANGE_DAYS} days` },
      { status: 400 },
    );
  }

  const search = sp.get("search")?.trim().toLowerCase() ?? "";
  const pageRaw = Number(sp.get("page"));
  const page = Number.isFinite(pageRaw) && pageRaw >= 0 ? Math.floor(pageRaw) : 0;
  const pageSizeRaw = Number(sp.get("pageSize"));
  const pageSize =
    Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
      ? Math.min(100, Math.floor(pageSizeRaw))
      : 20;
  const sortBy = SORTABLE.has(sp.get("sortBy") ?? "")
    ? (sp.get("sortBy") as string)
    : "revenue";
  const sortDir = sp.get("sortDir") === "asc" ? "asc" : "desc";

  const rows = await db
    .select({
      stage_id: keitaro_stage_results.stage_id,
      campaign_id: keitaro_stage_results.campaign_id,
      stage_tracking_id: keitaro_stage_results.stage_tracking_id,
      campaign_name: campaigns.name,
      link_mode: campaigns.link_mode,
      stage_number: campaign_stages.stage_number,
      stage_label: campaign_stages.label,
      // Per-stage send anchor + lifetime manual counters. In the activity-date
      // model a manual send/sale has no per-event timeline, so we attribute the
      // whole lifetime counter to the stage's single send moment (`sent_at`).
      stage_sent_at: campaign_stages.sent_at,
      stage_sms_count: campaign_stages.sms_count,
      // Auto-calculated SMS send cost (cost_per_sms × (sends + opt_outs)),
      // owned by lib/stages/total-cost.ts. This — NOT keitaro_stage_results.cost
      // (Keitaro ad-platform spend, always 0 here) — is the report's Cost source.
      stage_total_cost: campaign_stages.total_cost,
      visit_clicks_raw: keitaro_stage_results.visit_clicks_raw,
      visit_clicks_clean: keitaro_stage_results.visit_clicks_clean,
      redirect_clicks_raw: keitaro_stage_results.redirect_clicks_raw,
      redirect_clicks_clean: keitaro_stage_results.redirect_clicks_clean,
      raw_clicks: keitaro_stage_results.raw_clicks,
      clean_clicks: keitaro_stage_results.clean_clicks,
      sales: keitaro_stage_results.sales,
      revenue: keitaro_stage_results.revenue,
      cost: keitaro_stage_results.cost,
    })
    .from(keitaro_stage_results)
    .innerJoin(
      campaigns,
      eq(campaigns.id, keitaro_stage_results.campaign_id),
    )
    .leftJoin(
      campaign_stages,
      eq(campaign_stages.id, keitaro_stage_results.stage_id),
    )
    .where(
      and(
        eq(keitaro_stage_results.org_id, auth.orgId),
        gte(keitaro_stage_results.stat_date, from),
        lte(keitaro_stage_results.stat_date, to),
      ),
    );

  // Fold the per-day rows into one funnel per stage over the range.
  interface StageAcc {
    stage_id: number;
    campaign_id: number;
    campaign_name: string;
    link_mode: string;
    stage_number: number | null;
    stage_label: string | null;
    stage_tracking_id: string;
    // Send anchor + lifetime SMS count, copied off the stage row. Used to
    // attribute manual SENDS/cost to the send moment under activity scoping.
    // (Manual SALES are attributed by ledger entry date, not this anchor.)
    stage_sent_at: Date | null;
    stage_sms_count: number;
    // Lifetime auto/override SMS cost off the stage row, attributed to sent_at.
    stage_total_cost: number;
    // Opt-outs (STOPs credited to this stage) and successful sends WITHIN the
    // report's date range — both filled in from grouped queries after the fold.
    opt_outs: number;
    total_sent: number;
    tally: FunnelTally;
  }
  const byStage = new Map<number, StageAcc>();
  const grand = emptyFunnel();

  // Keitaro funnel (clickers/redirect/sales/revenue/cost) is already date-bounded
  // by stat_date. Sales here starts as the Keitaro conversion count IN RANGE; the
  // operator's MANUAL sales are combined below by their LEDGER ENTRY DATE
  // (stage_manual_sales.created_at in range) — the conversion-date basis shared
  // with the dashboard (lib/reporting/attribution.ts, ATTRIBUTION_BASIS).
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
        stage_sent_at: r.stage_sent_at,
        stage_sms_count: r.stage_sms_count ?? 0,
        stage_total_cost: Number(r.stage_total_cost ?? 0),
        opt_outs: 0,
        total_sent: 0,
        tally: emptyFunnel(),
      };
      byStage.set(r.stage_id, acc);
    }
    addRowToFunnel(acc.tally, r);
  }

  // Per-stage counters that DO carry an event time get scoped to the same ET
  // date range as the Keitaro funnel: [from 00:00 ET, day-after-`to` 00:00 ET).
  // Computing the exclusive upper bound off the next calendar day (not +24h)
  // keeps it correct across DST transitions (23h/25h days).
  const fromUtc = fromZonedTime(`${from}T00:00:00`, CAMPAIGN_TIMEZONE);
  const toExclusiveUtc = fromZonedTime(
    `${addOneDay(to)}T00:00:00`,
    CAMPAIGN_TIMEZONE,
  );

  // Include stages that were SENT in-range even when Keitaro has no results row
  // for them yet (a stage that got zero tracked clicks, or whose clicks haven't
  // been polled, produces no keitaro_stage_results row). Without this, such a
  // stage is invisible here and its real send Cost + Total Sent are silently
  // dropped — the Reports totals then under-report vs the send-truth (and vs the
  // Telegram spend snapshot, which sums campaign_stages.total_cost by sent_at).
  // We seed an empty funnel for each; the per-stage phase below fills in
  // total_sent / opt_outs / cost exactly as it does for Keitaro-present stages.
  const sentStageRows = await db
    .select({
      stage_id: campaign_stages.id,
      campaign_id: campaign_stages.campaign_id,
      campaign_name: campaigns.name,
      link_mode: campaigns.link_mode,
      stage_number: campaign_stages.stage_number,
      stage_label: campaign_stages.label,
      stage_tracking_id: campaign_stages.tracking_id,
      stage_sent_at: campaign_stages.sent_at,
      stage_sms_count: campaign_stages.sms_count,
      stage_total_cost: campaign_stages.total_cost,
    })
    .from(campaign_stages)
    .innerJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
    .where(
      and(
        eq(campaign_stages.org_id, auth.orgId),
        isNull(campaign_stages.archived_at),
        gte(campaign_stages.sent_at, fromUtc),
        lt(campaign_stages.sent_at, toExclusiveUtc),
      ),
    );
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
      stage_sent_at: r.stage_sent_at,
      stage_sms_count: r.stage_sms_count ?? 0,
      stage_total_cost: Number(r.stage_total_cost ?? 0),
      opt_outs: 0,
      total_sent: 0,
      tally: emptyFunnel(),
    });
  }

  const stageIds = [...byStage.keys()];
  let grandOptOuts = 0;
  let grandTotalSent = 0;
  let grandSalesTopup = 0;
  let grandTotalCost = 0;
  if (stageIds.length > 0) {
    // Opt-outs = STOPs credited to the stage (opt_out_attributions) whose credit
    // landed in range. created_at ≈ STOP receipt (poller lag ≤15min); it's the
    // per-stage event time, unlike the lifetime campaign_stages.inbound_opt_out_count.
    // These three are independent and share the same stageIds/range — run them
    // in parallel (one round-trip of latency instead of three sequential).
    //  * optOutRows — opt-outs = STOPs credited to the stage (opt_out_attributions)
    //    whose credit landed in range.
    //  * sentRows — API (tracked) Total Sent = successful per-recipient sends
    //    (status='sent') with sent_at in range. Manual-send campaigns have NO
    //    stage_sends rows and fall back to the stage's lifetime sms_count below.
    //  * manualSalesByStage — manual sales by LEDGER ENTRY DATE (conversion-date
    //    basis), distinct from the send-moment gating that governs manual cost.
    const [optOutRows, sentRows, manualSalesByStage] = await Promise.all([
      db
        .select({
          stage_id: opt_out_attributions.stage_id,
          n: sql<number>`count(*)::int`,
        })
        .from(opt_out_attributions)
        .where(
          and(
            eq(opt_out_attributions.org_id, auth.orgId),
            inArray(opt_out_attributions.stage_id, stageIds),
            gte(opt_out_attributions.created_at, fromUtc),
            lt(opt_out_attributions.created_at, toExclusiveUtc),
          ),
        )
        .groupBy(opt_out_attributions.stage_id),
      db
        .select({
          stage_id: stage_sends.stage_id,
          sent: sql<number>`count(*)::int`,
        })
        .from(stage_sends)
        .where(
          and(
            eq(stage_sends.org_id, auth.orgId),
            eq(stage_sends.status, "sent"),
            inArray(stage_sends.stage_id, stageIds),
            gte(stage_sends.sent_at, fromUtc),
            lt(stage_sends.sent_at, toExclusiveUtc),
          ),
        )
        .groupBy(stage_sends.stage_id),
      manualSalesByStageInRange({
        orgId: auth.orgId,
        fromUtc,
        toExclusiveUtc,
      }),
    ]);
    const optOutsByStage = new Map(optOutRows.map((o) => [o.stage_id, Number(o.n)]));
    const sentByStage = new Map(sentRows.map((s) => [s.stage_id, Number(s.sent)]));

    // Whether a stage's single send moment falls inside the report window. Manual
    // SENDS/cost carry no per-event timeline, so under activity-date scoping the
    // whole lifetime counter is attributed to `sent_at` (the send activity).
    const sentInRange = (sentAt: Date | null): boolean =>
      sentAt != null && sentAt >= fromUtc && sentAt < toExclusiveUtc;

    for (const acc of byStage.values()) {
      acc.opt_outs = optOutsByStage.get(acc.stage_id) ?? 0;
      const inRange = sentInRange(acc.stage_sent_at);
      // Total Sent: tracked campaigns have real per-recipient send rows; manual
      // campaigns store the count on the stage and are attributed to sent_at.
      acc.total_sent =
        acc.link_mode === "tracked"
          ? sentByStage.get(acc.stage_id) ?? 0
          : inRange
            ? acc.stage_sms_count
            : 0;
      // Sales = max(manual-in-range, Keitaro conversions-in-range), NOT the sum: a
      // sale that's both Keitaro-tracked and manually tallied is the SAME sale, so
      // summing double-counts it. acc.tally.sales currently holds the in-range
      // Keitaro sum; we top it up to the manual tally (manual sales whose ledger
      // entry date lands in range) only when the latter is larger. This dedupes the
      // overlap while preserving a manual baseline that exceeds Keitaro's (under-
      // counted) view. Mirrors combineSales() in lib/stage-results.
      const manualInRange = manualSalesByStage.get(acc.stage_id) ?? 0;
      const manual = Math.max(0, manualInRange - acc.tally.sales);
      acc.tally.sales += manual;
      // Cost = the stage's auto-calculated SMS spend (campaign_stages.total_cost),
      // attributed to its single send moment under activity-date scoping — same
      // rule as total_sent / manual sales. Overwrites the per-row Keitaro cost
      // (ad-platform spend, always 0 here) folded in above. When the send falls
      // outside the window the cost is 0, keeping it consistent with the 0 sends.
      acc.tally.cost = inRange ? acc.stage_total_cost : 0;
      grandOptOuts += acc.opt_outs;
      grandTotalSent += acc.total_sent;
      grandSalesTopup += manual;
      grandTotalCost += acc.tally.cost;
    }
  }
  // Fold the per-stage manual top-ups into the grand total once: grand.sales held
  // the Keitaro-only sum, so this lifts it to Σ max(manual, Keitaro) per stage.
  grand.sales += grandSalesTopup;
  // grand.cost held the per-row Keitaro sum (≈0); replace it with the summed
  // per-stage attributed SMS cost so the totals card + profit use real spend.
  grand.cost = grandTotalCost;

  // Group-by: per-stage rows (default) or campaign rollups. Campaign rows fold
  // every stage of a campaign into one funnel (opt-outs summed across stages).
  const groupByCampaign = (sp.get("groupBy") ?? "stage") === "campaign";

  type OutRow = {
    stage_id: number | null;
    campaign_id: number;
    campaign_name: string;
    stage_number: number | null;
    stage_name: string | null;
    stage_tracking_id: string | null;
    stage_count: number | null; // # stages folded (campaign rows only)
    opt_outs: number;
    total_sent: number;
    opt_out_rate: number; // opt_outs / total_sent (fraction)
    click_rate: number; // clickers / total_sent (fraction) — CR
  } & ReturnType<typeof withFunnelDerived>;

  let data: OutRow[];
  if (groupByCampaign) {
    interface CampAcc {
      campaign_id: number;
      campaign_name: string;
      stage_count: number;
      opt_outs: number;
      total_sent: number;
      tally: FunnelTally;
    }
    const byCampaign = new Map<number, CampAcc>();
    for (const acc of byStage.values()) {
      let c = byCampaign.get(acc.campaign_id);
      if (!c) {
        c = {
          campaign_id: acc.campaign_id,
          campaign_name: acc.campaign_name,
          stage_count: 0,
          opt_outs: 0,
          total_sent: 0,
          tally: emptyFunnel(),
        };
        byCampaign.set(acc.campaign_id, c);
      }
      c.stage_count += 1;
      c.opt_outs += acc.opt_outs;
      c.total_sent += acc.total_sent;
      mergeFunnel(c.tally, acc.tally);
    }
    data = [...byCampaign.values()].map((c) => ({
      stage_id: null,
      campaign_id: c.campaign_id,
      campaign_name: c.campaign_name,
      stage_number: null,
      stage_name: null,
      stage_tracking_id: null,
      stage_count: c.stage_count,
      opt_outs: c.opt_outs,
      total_sent: c.total_sent,
      opt_out_rate: rateOfSent(c.opt_outs, c.total_sent),
      click_rate: rateOfSent(c.tally.visit_clicks_clean, c.total_sent),
      ...withFunnelDerived(c.tally),
    }));
  } else {
    data = [...byStage.values()].map((acc) => {
      const stage_name =
        acc.stage_label?.trim() ||
        (acc.stage_number != null ? `Stage ${acc.stage_number}` : "Stage");
      return {
        stage_id: acc.stage_id,
        campaign_id: acc.campaign_id,
        campaign_name: acc.campaign_name,
        stage_number: acc.stage_number,
        stage_name,
        stage_tracking_id: acc.stage_tracking_id,
        stage_count: null,
        opt_outs: acc.opt_outs,
        total_sent: acc.total_sent,
        opt_out_rate: rateOfSent(acc.opt_outs, acc.total_sent),
        click_rate: rateOfSent(acc.tally.visit_clicks_clean, acc.total_sent),
        ...withFunnelDerived(acc.tally),
      };
    });
  }

  if (search) {
    data = data.filter(
      (d) =>
        d.campaign_name.toLowerCase().includes(search) ||
        (d.stage_name?.toLowerCase().includes(search) ?? false) ||
        (d.stage_tracking_id?.toLowerCase().includes(search) ?? false),
    );
  }

  data.sort((a, b) => {
    let cmp: number;
    if (sortBy === "campaign_name") {
      cmp = a.campaign_name.localeCompare(b.campaign_name);
    } else {
      cmp =
        (a[sortBy as keyof typeof a] as number) -
        (b[sortBy as keyof typeof b] as number);
    }
    // Stable tiebreak: stage_id when present, else campaign_id (campaign rows).
    if (cmp === 0)
      cmp = (a.stage_id ?? a.campaign_id) - (b.stage_id ?? b.campaign_id);
    return sortDir === "asc" ? cmp : -cmp;
  });

  const totalCount = data.length;
  const paged = data.slice(page * pageSize, page * pageSize + pageSize);

  return NextResponse.json({
    data: paged,
    totalCount,
    page,
    pageSize,
    totals: {
      ...withFunnelDerived(grand),
      opt_outs: grandOptOuts,
      total_sent: grandTotalSent,
      opt_out_rate: rateOfSent(grandOptOuts, grandTotalSent),
      click_rate: rateOfSent(grand.visit_clicks_clean, grandTotalSent),
    },
    range: { from, to, timezone: CAMPAIGN_TIMEZONE },
  });
}
