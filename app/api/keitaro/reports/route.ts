import { NextResponse, type NextRequest } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import {
  emptyFunnel,
  mergeFunnel,
  withFunnelDerived,
  type FunnelTally,
} from "@/lib/keitaro/funnel";
import { can } from "@/lib/permissions";
import { denominatorFor } from "@/lib/reporting/counted-clickers";
import {
  getDeliveryByStage,
  getPhoneDirectory,
  getStageDirectory,
  rollupByCampaign,
  rollupByStage,
  type DeliveryCell,
} from "@/lib/reporting/delivery";
import { getStageMetricsInRange } from "@/lib/reporting/stage-funnel";
import {
  shouldSubstituteClickers,
  substitutionDominates,
} from "@/lib/reporting/tracking-gap";

// Cross-campaign Keitaro reports (the /reports "Overview" tab): per-stage
// Clickers → Offer Redirect → Sales funnel over a date range (ET). The per-stage
// metric computation now lives in the shared getStageMetricsInRange() so the
// by-number/offer/sequence/group performance reports compute from the identical
// numbers. This route only groups (stage/campaign), sorts, paginates, responds.
export const dynamic = "force-dynamic";

// Lifetime EPC: all-time revenue over all-time counted clickers, ignoring the
// date filter. Distinct from the period figure and never derived from it —
// counted clickers are deduplicated and therefore not additive over time.
function lifetimeEpc(revenue: number, clickers: number): number {
  return clickers > 0 ? revenue / clickers : 0;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;
// The Delivered % column only. MUST stay <= the cap in
// app/api/reports/delivery/route.ts — both are bounded by the same measured
// stage_sends scan (473 ms at 7 days, 11.0 s at 30).
const DELIVERY_MAX_RANGE_DAYS = 14;

export const SORTABLE = new Set([
  "campaign_name",
  "clickers",
  "offer_redirect",
  "redirect_rate",
  "sales",
  "sales_cr",
  "revenue",
  "cost",
  "epc",
  // Added with the lifetime columns. A column rendered with enableSorting but
  // absent from this whitelist silently falls back to sorting by revenue — the
  // header responds and the order changes, just not by what was clicked.
  "lifetime_epc",
  "lifetime_clickers",
  "counted_clickers",
  "profit",
  "opt_outs",
  "total_sent",
  "opt_out_rate",
  "click_rate",
]);

function rateOfSent(numerator: number, totalSent: number): number {
  return totalSent > 0 ? numerator / totalSent : 0;
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
  const spanDays =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
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

  const { stages, grand, grandOptOuts, grandTotalSent, clickers } =
    await getStageMetricsInRange(auth.orgId, from, to);

  // link_mode per campaign, so manual-mode rows fall back to Keitaro visits.
  const linkModeByCampaign = new Map(stages.map((s) => [s.campaign_id, s.link_mode]));

  // ── READ-TIME CLICKERS FALLBACK ──────────────────────────────────────────
  //
  // When a landing page loses its Keitaro visit script, both visit columns
  // read 0 (hasNoKeitaroVisits) while CamMan keeps recording every tap — so
  // the Clickers column reports "nobody clicked" for a stage that got
  // thousands of taps. The /api/cron/tracking-monitors job alerts on it; this
  // makes the number on screen honest in the meantime, and for every past
  // period at once.
  //
  // ⚠️ DISPLAY-TIME ONLY. Writing CamMan counts into keitaro_stage_results would
  // poison the sync source and the next poll would fight it. Nothing here
  // persists; the substitution self-retires the moment visits resume.
  //
  // ⚠️ THE SUBSTITUTE IS counted_clickers, NOT raw taps. Measured over the 284
  // healthy guidekn stages: counted_clickers = 1.35x visit_clicks_clean, while
  // distinct contacts across ALL clicks = 11.0x. Rendering the unfiltered figure
  // would put an 11x-inflated number beside counted_clickers in the same row.
  //
  // ⚠️ STAGE GRAIN, DELIBERATELY. The Keitaro column is itself assembled by
  // summing per-stage rows, so summing stage-grain counted_clickers matches how
  // the number it replaces is built. periodByCampaign is deduplicated at
  // campaign grain and would make a fallback row systematically smaller.
  //
  // Gated to link_mode 'tracked': manual campaigns mint no links, so they have
  // no CamMan clicks, and denominatorFor() still reads the real Keitaro value
  // for them. The gate makes that structural rather than coincidental.
  // How much of each stage's rendered Clickers figure is a CamMan substitute.
  // A Map, not the old Set: a grouped row needs the AMOUNT substituted to judge
  // whether the substitute dominates it (substitutionDominates), and `some()`
  // over a Set is exactly what marked whole campaigns for one small stage.
  const substitutedByStage = new Map<number, number>();
  let substitutedTotal = 0;
  const now = new Date();
  for (const s of stages) {
    const cammanClickers = clickers.periodByStage.get(s.stage_id) ?? 0;
    // The WHOLE rule lives in lib/reporting/tracking-gap.ts — link_mode,
    // both visit columns, a non-zero CamMan count, and the maturity gate. It is
    // shared with scripts/verify-clickers-fallback.ts so the guard cannot
    // transcribe a stale copy of it.
    if (
      !shouldSubstituteClickers({
        linkMode: s.link_mode,
        visitClicksRaw: s.tally.visit_clicks_raw,
        visitClicksClean: s.tally.visit_clicks_clean,
        countedClickers: cammanClickers,
        stageSentAt: s.sent_at,
        now,
      })
    ) {
      continue;
    }
    s.tally.visit_clicks_clean = cammanClickers;
    // `grand` was accumulated inside getStageMetricsInRange BEFORE this patch,
    // so it does not see the mutation above and must be topped up by hand.
    // Gap stages contributed 0 to the Keitaro side, so this cannot double-count.
    grand.visit_clicks_clean += cammanClickers;
    substitutedByStage.set(s.stage_id, cammanClickers);
    substitutedTotal += cammanClickers;
  }

  const groupByCampaign = (sp.get("groupBy") ?? "stage") === "campaign";

  type OutRow = {
    stage_id: number | null;
    campaign_id: number;
    campaign_name: string;
    stage_number: number | null;
    stage_name: string | null;
    stage_tracking_id: string | null;
    stage_count: number | null;
    opt_outs: number;
    total_sent: number;
    opt_out_rate: number;
    click_rate: number;
    // True when `clickers` is CamMan's counted-clicker count standing in for a
    // missing Keitaro visit count. The UI marks the value and blanks
    // redirect_rate and click_rate — not because both divide by the missing
    // denominator (only redirect_rate does; click_rate's denominator is
    // total_sent, and the substitute IS its numerator), but because both would
    // mix a Keitaro basis with a CamMan one in the same rate.
    clickers_is_fallback: boolean;
    // Lifetime EPC ignores the date filter entirely and is the PRIMARY figure;
    // `epc` from withFunnelDerived is the period figure for the selected range.
    // Each carries its own denominator: a $0.00 EPC is only interpretable when
    // you can see the count it divided by was 4.
    lifetime_epc: number;
    lifetime_clickers: number;
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
    for (const acc of stages) {
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
      clickers_is_fallback: substitutionDominates(
        stages.reduce(
          (n, s) =>
            s.campaign_id === c.campaign_id
              ? n + (substitutedByStage.get(s.stage_id) ?? 0)
              : n,
          0,
        ),
        c.tally.visit_clicks_clean,
      ),
      ...withFunnelDerived(
        c.tally,
        denominatorFor(
          linkModeByCampaign.get(c.campaign_id),
          clickers.periodByCampaign.get(c.campaign_id),
          c.tally.visit_clicks_clean,
        ),
      ),
      lifetime_epc: lifetimeEpc(
        clickers.lifetimeRevenueByCampaign.get(c.campaign_id) ?? 0,
        denominatorFor(
          linkModeByCampaign.get(c.campaign_id),
          clickers.lifetimeByCampaign.get(c.campaign_id),
          c.tally.visit_clicks_clean,
        ),
      ),
      lifetime_clickers: denominatorFor(
        linkModeByCampaign.get(c.campaign_id),
        clickers.lifetimeByCampaign.get(c.campaign_id),
        c.tally.visit_clicks_clean,
      ),
    }));
  } else {
    data = stages.map((acc) => {
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
        // Same rule as the campaign row. A substituted stage has
        // substituted === total, so this is identical to the old
        // `has(stage_id)` test — stated once so the two grains cannot drift.
        clickers_is_fallback: substitutionDominates(
          substitutedByStage.get(acc.stage_id) ?? 0,
          acc.tally.visit_clicks_clean,
        ),
        ...withFunnelDerived(
          acc.tally,
          denominatorFor(
            acc.link_mode,
            clickers.periodByStage.get(acc.stage_id),
            acc.tally.visit_clicks_clean,
          ),
        ),
        lifetime_epc: lifetimeEpc(
          clickers.lifetimeRevenueByStage.get(acc.stage_id) ?? 0,
          denominatorFor(
            acc.link_mode,
            clickers.lifetimeByStage.get(acc.stage_id),
            acc.tally.visit_clicks_clean,
          ),
        ),
        lifetime_clickers: denominatorFor(
          acc.link_mode,
          clickers.lifetimeByStage.get(acc.stage_id),
          acc.tally.visit_clicks_clean,
        ),
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
    if (cmp === 0)
      cmp = (a.stage_id ?? a.campaign_id) - (b.stage_id ?? b.campaign_id);
    return sortDir === "asc" ? cmp : -cmp;
  });

  // ---- Delivered % (lib/reporting/delivery.ts — the shared layer) ----------
  //
  // ⚠️ CONDITIONAL ON THE RANGE, and that is not an optimisation. This route
  // permits 92 days; the delivery query costs 473 ms over 7 days but 11.0 s over
  // 30 (it scans stage_sends, which has no covering index — ClickUp 869ehwae3).
  // Running it unconditionally would make a wide Overview range time out. Past
  // the cap the column reports null and the UI says why, rather than silently
  // showing "—" that reads as "no delivery data".
  //
  // Computed AFTER paging is decided but over the FULL row set, then attached —
  // each grain aggregates the shared stage rows ITSELF (campaign rows via
  // rollupByCampaign, stage rows via rollupByStage). No grain reads another's
  // output.
  const deliveryAvailable = spanDays <= DELIVERY_MAX_RANGE_DAYS;
  let deliveryByCampaign = new Map<number, DeliveryCell>();
  let deliveryByStage = new Map<number, DeliveryCell>();
  if (deliveryAvailable) {
    const [deliveryRows, stageDir, phoneDir] = await Promise.all([
      getDeliveryByStage(auth.orgId, { from, to }),
      getStageDirectory(auth.orgId),
      getPhoneDirectory(auth.orgId),
    ]);
    // Campaign comes via the stage (structural); capability via the send's own
    // number (a stage's number can change between materialization windows).
    deliveryByCampaign = rollupByCampaign(deliveryRows, stageDir, phoneDir);
    deliveryByStage = rollupByStage(deliveryRows, phoneDir);
  }
  const withDelivery = data.map((r) => {
    const cell = groupByCampaign
      ? deliveryByCampaign.get(r.campaign_id)
      : r.stage_id != null
        ? deliveryByStage.get(r.stage_id)
        : undefined;
    return {
      ...r,
      delivered_pct: cell?.delivered_pct ?? null,
      // 100 ⇒ every send at this grain is DLR-capable and the figure needs no
      // qualifier. Below 100 the UI MUST label it: "91.4% (of 4% of sends)".
      delivery_coverage_pct: cell?.coverage_pct ?? null,
    };
  });

  const totalCount = withDelivery.length;
  const paged = withDelivery.slice(page * pageSize, page * pageSize + pageSize);

  return NextResponse.json({
    data: paged,
    delivery: {
      available: deliveryAvailable,
      max_days: DELIVERY_MAX_RANGE_DAYS,
    },
    totalCount,
    page,
    pageSize,
    totals: {
      ...withFunnelDerived(grand, clickers.periodTotal),
      lifetime_epc: lifetimeEpc(clickers.lifetimeRevenueTotal, clickers.lifetimeTotal),
      lifetime_clickers: clickers.lifetimeTotal,
      opt_outs: grandOptOuts,
      total_sent: grandTotalSent,
      opt_out_rate: rateOfSent(grandOptOuts, grandTotalSent),
      click_rate: rateOfSent(grand.visit_clicks_clean, grandTotalSent),
      clickers_is_fallback: substitutionDominates(
        substitutedTotal,
        grand.visit_clicks_clean,
      ),
    },
    range: { from, to, timezone: CAMPAIGN_TIMEZONE },
  });
}
