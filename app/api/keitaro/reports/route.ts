import { NextResponse, type NextRequest } from "next/server";

import { and, eq, gte, lte } from "drizzle-orm";

import { db } from "@/db/client";
import { campaign_stages, campaigns, keitaro_stage_results } from "@/db/schema";
import { requireApiMembership } from "@/lib/api/helpers";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import {
  addRowToFunnel,
  emptyFunnel,
  withFunnelDerived,
  type FunnelTally,
} from "@/lib/keitaro/funnel";
import { can } from "@/lib/permissions";

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
]);

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
      stage_number: campaign_stages.stage_number,
      stage_label: campaign_stages.label,
      opt_out_count: campaign_stages.opt_out_count,
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
    stage_number: number | null;
    stage_label: string | null;
    stage_tracking_id: string;
    // Per-stage denormalized counter (not per-day) — captured once, never summed.
    opt_outs: number;
    tally: FunnelTally;
  }
  const byStage = new Map<number, StageAcc>();
  const grand = emptyFunnel();
  let grandOptOuts = 0;

  for (const r of rows) {
    addRowToFunnel(grand, r);
    let acc = byStage.get(r.stage_id);
    if (!acc) {
      acc = {
        stage_id: r.stage_id,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name ?? "(unnamed)",
        stage_number: r.stage_number,
        stage_label: r.stage_label,
        stage_tracking_id: r.stage_tracking_id,
        opt_outs: r.opt_out_count ?? 0,
        tally: emptyFunnel(),
      };
      byStage.set(r.stage_id, acc);
      grandOptOuts += acc.opt_outs;
    }
    addRowToFunnel(acc.tally, r);
  }

  let data = [...byStage.values()].map((acc) => {
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
      opt_outs: acc.opt_outs,
      ...withFunnelDerived(acc.tally),
    };
  });

  if (search) {
    data = data.filter(
      (d) =>
        d.campaign_name.toLowerCase().includes(search) ||
        d.stage_name.toLowerCase().includes(search) ||
        d.stage_tracking_id.toLowerCase().includes(search),
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
    if (cmp === 0) cmp = a.stage_id - b.stage_id; // stable tiebreak
    return sortDir === "asc" ? cmp : -cmp;
  });

  const totalCount = data.length;
  const paged = data.slice(page * pageSize, page * pageSize + pageSize);

  return NextResponse.json({
    data: paged,
    totalCount,
    page,
    pageSize,
    totals: { ...withFunnelDerived(grand), opt_outs: grandOptOuts },
    range: { from, to, timezone: CAMPAIGN_TIMEZONE },
  });
}
