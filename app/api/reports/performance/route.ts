import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { can } from "@/lib/permissions";
import { readCreativeLifetime } from "@/lib/reporting/creative-lifetime";
import { loadEventTypes } from "@/lib/reporting/event-columns";
import { hideBelowMinSent, rpmOf, sortCreativeRows } from "@/lib/reporting/creative-rows";
import {
  getPerformanceReport,
  getReportProviderOptions,
  gradePerf,
  ZERO,
  type PerfMetrics,
  type PerfRow,
} from "@/lib/reporting/performance-report";
import {
  API_ONLY_DIMENSIONS,
  ATTRIBUTION_BASES,
  CREATIVE_SORT_KEYS,
  isAttributionBasis,
  isCreativeSortKey,
  isPerformanceDimension,
  REPORT_DIMENSIONS,
  type CreativeSortKey,
} from "@/lib/reporting/report-dimensions";

// Read API for the performance reports. Number/offer/sequence/group/creative
// source from the shared per-stage Keitaro funnel (matches the Overview tab);
// hourly buckets by user-activity time. `creative` is API-only (no Reports tab)
// and adds range=lifetime (hourly snapshot), offer_id, min_sent and sortBy.
// Gated on campaigns.view (same as Overview).
export const dynamic = "force-dynamic";
// A long attribution=send_date range counts every send of every cohort stage
// (~10s for 7 days, measured 2026-09-14); give it headroom over the default.
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;
const MAX_INT4 = 2_147_483_647;
const CREATIVE_ONLY_PARAMS = ["range", "offer_id", "min_sent", "sortBy"] as const;

const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });

// Creative rows and totals for the response: grading fields + rpm, the offer
// filter, the min_sent hide and the server-side sort.
function creativeBody(
  rows: PerfRow[],
  totals: PerfMetrics,
  offerId: number | null,
  minSent: number,
  sortBy: CreativeSortKey,
) {
  const inOffer = offerId == null ? rows : rows.filter((r) => r.offer_id === offerId);
  const graded = inOffer.map((r) => ({ ...gradePerf(r), rpm: rpmOf(r.revenue, r.sent) }));
  const { rows: kept, hidden } = hideBelowMinSent(graded, minSent);
  return {
    data: sortCreativeRows(kept, sortBy),
    totals: { ...gradePerf(totals), rpm: rpmOf(totals.revenue, totals.sent) },
    hidden_rows: hidden,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "reports/performance",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "campaigns.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;

  const dimensionRaw = sp.get("dimension") ?? "";
  if (!isPerformanceDimension(dimensionRaw)) {
    return badRequest(
      `Unknown dimension. Expected one of: ${[...REPORT_DIMENSIONS, ...API_ONLY_DIMENSIONS].join(", ")}`,
    );
  }
  const dimension = dimensionRaw;
  const creative = dimension === "creative";

  // Creative-only params are rejected elsewhere, never silently ignored.
  for (const p of CREATIVE_ONLY_PARAMS) {
    if (!creative && sp.has(p)) return badRequest(`${p} is only supported for dimension=creative`);
  }
  const rangeRaw = sp.get("range");
  if (rangeRaw != null && rangeRaw !== "lifetime") {
    return badRequest("range must be lifetime, or omitted to use from/to");
  }
  const lifetime = rangeRaw === "lifetime";
  if (lifetime && (sp.has("from") || sp.has("to") || sp.has("provider_phone_id"))) {
    return badRequest("range=lifetime cannot be combined with from, to or provider_phone_id");
  }
  const offerRaw = sp.get("offer_id");
  const offerId =
    offerRaw == null
      ? null
      : /^\d+$/.test(offerRaw) && Number(offerRaw) > 0 && Number(offerRaw) <= MAX_INT4
        ? Number(offerRaw)
        : Number.NaN;
  if (Number.isNaN(offerId)) return badRequest("offer_id must be a positive whole number");
  if (offerId != null && sp.has("provider_phone_id")) {
    return badRequest("offer_id cannot be combined with provider_phone_id");
  }
  const minSentRaw = sp.get("min_sent");
  const minSent = minSentRaw == null ? 0 : /^\d+$/.test(minSentRaw) ? Number(minSentRaw) : Number.NaN;
  if (Number.isNaN(minSent)) return badRequest("min_sent must be a whole number of 0 or more");
  const sortRaw = sp.get("sortBy") ?? "revenue";
  if (!isCreativeSortKey(sortRaw)) {
    return badRequest(`Unknown sortBy. Expected one of: ${CREATIVE_SORT_KEYS.join(", ")}`);
  }
  const sortBy = sortRaw;

  // conversion_date (default) = every metric on its own event day; send_date = the
  // cohort of stages sent in range, with everything they have produced to date.
  const attributionRaw = sp.get("attribution") ?? "conversion_date";
  if (!isAttributionBasis(attributionRaw)) {
    return badRequest(`Unknown attribution. Expected one of: ${ATTRIBUTION_BASES.join(", ")}`);
  }
  const attribution = attributionRaw;
  if (dimension === "hourly" && attribution === "send_date") {
    return badRequest("hourly buckets by event time; attribution=send_date is not supported for it");
  }

  if (lifetime) {
    const stored = await readCreativeLifetime(auth.orgId, attribution);
    if (!stored) {
      // 503, not an empty 200: "never computed" is a service state, not zero rows.
      return NextResponse.json(
        {
          error: "Lifetime creative rows have not been computed yet. The refresh runs hourly.",
          code: "internal",
          details: { reason: "rollup_not_ready" },
        },
        { status: 503 },
      );
    }
    const totals =
      offerId == null ? stored.basis.totals : stored.basis.offer_totals[String(offerId)] ?? ZERO;
    const [providers, eventTypes] = await Promise.all([
      getReportProviderOptions(auth.orgId),
      loadEventTypes(db, auth.orgId),
    ]);
    return NextResponse.json({
      dimension,
      attribution,
      sort_by: sortBy,
      min_sent: minSent,
      offer_id: offerId,
      ...creativeBody(stored.basis.rows, totals, offerId, minSent, sortBy),
      refreshedAt: stored.basis.refreshedAt,
      providers,
      event_types: eventTypes,
      range: {
        lifetime: true,
        from: stored.basis.from,
        to: stored.basis.to,
        timezone: CAMPAIGN_TIMEZONE,
      },
      computed_at: stored.computedAt,
      stale_seconds: Math.max(0, Math.round((Date.now() - Date.parse(stored.computedAt)) / 1000)),
    });
  }

  const todayEt = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  const from = fromRaw && DATE_RE.test(fromRaw) ? fromRaw : todayEt;
  // Hourly buckets by hour-of-day across the whole range (each hour summed over
  // all days), so it takes a from/to range like every other dimension.
  const to = toRaw && DATE_RE.test(toRaw) ? toRaw : todayEt;

  if (from > to) return badRequest("`from` must be on or before `to`");
  const spanDays =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) return badRequest(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);

  const providerRaw = sp.get("provider_phone_id");
  const providerPhoneId =
    providerRaw && /^\d+$/.test(providerRaw) ? Number(providerRaw) : null;

  // The registry rides along in the same round trip — it is one grouped read of a
  // 2-rows-per-org table, and the column set is useless without it. It goes on
  // ALL THREE response bodies, INCLUDING the two `dimension=creative` ones,
  // which serve no screen (API_ONLY_DIMENSIONS — there is no Reports tab for
  // them). KEPT DELIBERATELY: those bodies carry `events` and `unmapped` on
  // every row like the others, and a key is not a label — without the registry
  // an API consumer has a map of `event_types.key` it cannot name, order, or
  // tell "counts revenue" from "signal". Dropping it would make the one
  // consumer that has no UI to fall back on the only one that cannot read the
  // breakdown. Documented in docs/operator-api.md §3, "Creative bank".
  const [report, providers, eventTypes] = await Promise.all([
    getPerformanceReport(auth.orgId, dimension, { from, to, providerPhoneId, attribution, offerId }),
    getReportProviderOptions(auth.orgId),
    loadEventTypes(db, auth.orgId),
  ]);

  if (creative) {
    return NextResponse.json({
      dimension,
      attribution,
      sort_by: sortBy,
      min_sent: minSent,
      offer_id: offerId,
      ...creativeBody(report.rows, report.totals, offerId, minSent, sortBy),
      refreshedAt: report.refreshedAt,
      providers,
      event_types: eventTypes,
      range: { from, to, timezone: CAMPAIGN_TIMEZONE },
    });
  }

  return NextResponse.json({
    dimension,
    attribution,
    // Operator-API grading fields on every row and the totals (gradePerf).
    data: report.rows.map((r) => gradePerf(r)),
    totals: gradePerf(report.totals),
    refreshedAt: report.refreshedAt,
    providers,
    event_types: eventTypes,
    range: { from, to, timezone: CAMPAIGN_TIMEZONE },
  });
}
