import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { getDripDailyResults } from "@/lib/reporting/drip-daily-results";
import { getCalibratedLookupRate } from "@/lib/reporting/lookup-rate";
import { can } from "@/lib/permissions";

// Drip campaign "Daily results" (spec 2026-10-12, PR 4). Reads drip_daily_rollup
// only — see lib/reporting/drip-daily-results.ts.
//
// Gated on org_settings.drip_daily_results_enabled (migration 0208). ?probe=1
// answers { enabled } so the page knows whether to show the tab at all.
//
// DRIP_DAILY_RESULTS_LOCAL_PREVIEW=1 opens the gate on a LOCAL `next dev` only —
// for reviewing the tab against real data while the org flag stays off. It is
// ignored whenever NODE_ENV is "production", which every Vercel deployment
// (preview included) is.
export const dynamic = "force-dynamic";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z
  .object({
    basis: z.enum(["activity", "cohort"]).default("activity"),
    breakdown: z.enum(["none", "stage", "partner"]).default("none"),
    from: ymd,
    to: ymd,
  })
  .refine((q) => q.from <= q.to, { message: "from must not be after to", path: ["from"] });

async function enabled(orgId: string): Promise<boolean> {
  if (process.env.NODE_ENV !== "production" && process.env.DRIP_DAILY_RESULTS_LOCAL_PREVIEW === "1") return true;
  const rows = (await db.execute(sql`
    SELECT drip_daily_results_enabled AS on FROM org_settings WHERE org_id = ${orgId}::uuid`)) as unknown as { on: boolean }[];
  return rows[0]?.on === true;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const cid = Number((await params).campaignId);
  if (!Number.isInteger(cid) || cid <= 0) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const on = await enabled(orgId);
  const sp = req.nextUrl.searchParams;
  if (sp.get("probe") === "1") return NextResponse.json({ enabled: on });
  if (!on) {
    return apiError(404, "Daily results are not enabled", API_ERROR_CODES.NOT_FOUND, { reason: "feature_disabled" });
  }

  const parsed = querySchema.safeParse(Object.fromEntries(sp));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return apiError(400, first?.message ?? "Invalid query", API_ERROR_CODES.VALIDATION, {
      field: first?.path.join("."),
    });
  }
  const q = parsed.data;
  const today = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const to = q.to > today ? today : q.to;

  const rate = await getCalibratedLookupRate();
  const result = await getDripDailyResults(db, {
    orgId,
    campaignId: cid,
    basis: q.basis,
    breakdown: q.breakdown,
    from: q.from,
    to,
    lookupRate: { rate: rate.rate, source: rate.source },
  });
  if (!result) {
    return apiError(404, "Drip campaign not found", API_ERROR_CODES.NOT_FOUND, { entity: "campaign" });
  }
  return NextResponse.json(result);
}
