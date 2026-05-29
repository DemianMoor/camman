import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_stages, campaigns, offers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { stageManualResultsSchema } from "@/lib/validators/campaign-stages";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Manual results entry. Directly SETS the stage's aggregate result counters
// from operator-supplied values, for providers that don't expose a report
// to import via CSV. Unlike the CSV import path this does NOT write
// stage_result_rows or propagate opt-outs/clickers — it only records the
// headline numbers. The values overwrite (not increment) whatever is there.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "result_imports.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId, stageId } = await params;
  const cid = parseId(campaignId);
  const sid = parseId(stageId);
  if (cid === null || sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = stageManualResultsSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const input = parsed.data;

  // Verify the stage belongs to this campaign and org before writing. Pull
  // the current sales snapshot and the campaign's offer CPA payout so we can
  // (re)snapshot sales_payout_each when the sales count changes.
  const owns = await db
    .select({
      id: campaign_stages.id,
      sales_count: campaign_stages.sales_count,
      sales_payout_each: campaign_stages.sales_payout_each,
      offer_payout_cpa: offers.payout_cpa,
    })
    .from(campaign_stages)
    .innerJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
    .leftJoin(offers, eq(offers.id, campaigns.offer_id))
    .where(
      and(
        eq(campaign_stages.id, sid),
        eq(campaign_stages.campaign_id, cid),
        eq(campaign_stages.org_id, orgId),
      ),
    )
    .limit(1);
  if (!owns[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "stage",
    });
  }

  // Snapshot the offer's CPA payout onto the stage so revenue/ROI reflect the
  // payout "on the date the sale was mapped". Re-snapshot only when the sales
  // count actually changes (or was never snapshotted) so editing other
  // counters doesn't silently re-rate existing sales at a newer payout. No
  // sales ⇒ no snapshot.
  let salesPayoutEach: string | null;
  if (input.sales_count === 0) {
    salesPayoutEach = null;
  } else if (
    input.sales_count !== owns[0].sales_count ||
    owns[0].sales_payout_each === null
  ) {
    salesPayoutEach = owns[0].offer_payout_cpa ?? null;
  } else {
    salesPayoutEach = owns[0].sales_payout_each;
  }

  const [updated] = await db
    .update(campaign_stages)
    .set({
      sms_count: input.sms_count,
      delivered_count: input.delivered_count,
      opt_out_count: input.opt_out_count,
      click_count: input.click_count,
      late_click_count: input.late_click_count,
      scrubbed_count: input.scrubbed_count,
      bounced_count: input.bounced_count,
      checkout_click_count: input.checkout_click_count,
      sales_count: input.sales_count,
      sales_payout_each: salesPayoutEach,
      total_cost: String(input.total_cost),
    })
    .where(
      and(
        eq(campaign_stages.id, sid),
        eq(campaign_stages.campaign_id, cid),
        eq(campaign_stages.org_id, orgId),
      ),
    )
    .returning();
  if (!updated) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "stage",
    });
  }
  return NextResponse.json(updated);
}
