import { type NextRequest, NextResponse } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { can } from "@/lib/permissions";
import {
  NO_DLR_NOTE,
  getDeliveryByStage,
  getProviderRegistry,
  getStageDirectory,
  rollupByProvider,
} from "@/lib/reporting/delivery";

// Read API for /reports/delivery — delivery receipts per provider over a window.
// Gated on campaigns.view, matching Overview and the performance reports.
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ⚠️ HARD CAP, and lower than the other reports' 92 days on purpose. MEASURED
// against prod (3.07M-row stage_sends): a 7-day window is 473 ms server-side; a
// 30-day window is 11.0 s, which would exceed the function limit. The cost is
// the stage_sends scan — stage_sends_org_sent_at_idx is (org_id, sent_at), so
// status/stage_id are heap fetches. Raising this cap REQUIRES the covering index
// first (ClickUp 869ehwae3); do not widen it on the assumption that it scales.
const MAX_RANGE_DAYS = 14;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "campaigns.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const todayEt = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  const from = fromRaw && DATE_RE.test(fromRaw) ? fromRaw : todayEt;
  const to = toRaw && DATE_RE.test(toRaw) ? toRaw : todayEt;

  if (from > to) {
    return NextResponse.json({ error: "`from` must be on or before `to`" }, { status: 400 });
  }
  const spanDays =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    return NextResponse.json(
      {
        error: `Date range cannot exceed ${MAX_RANGE_DAYS} days`,
        code: "range_too_wide",
      },
      { status: 400 },
    );
  }

  const [rows, stages, registry] = await Promise.all([
    getDeliveryByStage(auth.orgId, { from, to }),
    getStageDirectory(auth.orgId),
    getProviderRegistry(auth.orgId),
  ]);

  const data = rollupByProvider(rows, stages, registry);
  // Totals cover DLR-CAPABLE providers only — summing a null-capability
  // provider's sends into a delivery total would silently re-create the "0.0%
  // delivered across the platform" reading the capability gate exists to prevent.
  const capable = data.filter((p) => p.dlr_capable);
  const totals = {
    sent_all_providers: data.reduce((n, p) => n + p.sent, 0),
    sent: capable.reduce((n, p) => n + p.sent, 0),
    delivered: capable.reduce((n, p) => n + (p.delivered ?? 0), 0),
    undelivered: capable.reduce((n, p) => n + (p.undelivered ?? 0), 0),
    no_receipt: capable.reduce((n, p) => n + (p.no_receipt ?? 0), 0),
  };

  return NextResponse.json({
    data,
    totals,
    no_dlr_note: NO_DLR_NOTE,
    range: { from, to, timezone: CAMPAIGN_TIMEZONE, max_days: MAX_RANGE_DAYS },
  });
}
