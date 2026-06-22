import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  campaign_stages,
  campaigns,
  offers,
  provider_phones,
  stage_manual_sales,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { stageTotalCost } from "@/lib/stages/total-cost";
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
      // Provider-phone cost-per-SMS drives the auto Total Cost. NULL when no
      // phone is assigned (or the FK dangles) ⇒ treated as 0 below.
      cost_per_sms: provider_phones.cost_per_sms,
    })
    .from(campaign_stages)
    .innerJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
    .leftJoin(offers, eq(offers.id, campaigns.offer_id))
    .leftJoin(
      provider_phones,
      eq(provider_phones.id, campaign_stages.provider_phone_id),
    )
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

  // The sales tally is a single overwrite-on-save total, so record the signed
  // CHANGE in the manual-sales ledger (dated now) — that's what lets the
  // date-ranged Reports tab attribute manual sales to when they were entered.
  // SUM(delta) per stage stays equal to sales_count. Both writes in one tx.
  const salesDelta = input.sales_count - owns[0].sales_count;

  // Total Cost: an explicit override (total_cost_manual) stores the supplied
  // figure verbatim; otherwise derive it from the provider-phone cost so the
  // headline cost tracks cost_per_sms × (sends + opt-outs). The flag is
  // persisted so the opt-out poller knows whether it may recompute later.
  const costPerSms = Number(owns[0].cost_per_sms ?? 0);
  const totalCost = input.total_cost_manual
    ? input.total_cost
    : stageTotalCost(costPerSms, input.sms_count, input.opt_out_count);

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(campaign_stages)
      .set({
        sms_count: input.sms_count,
        delivered_count: input.delivered_count,
        opt_out_count: input.opt_out_count,
        click_count: input.click_count,
        scrubbed_count: input.scrubbed_count,
        bounced_count: input.bounced_count,
        checkout_click_count: input.checkout_click_count,
        sales_count: input.sales_count,
        sales_payout_each: salesPayoutEach,
        total_cost: String(totalCost),
        total_cost_manual: input.total_cost_manual,
      })
      .where(
        and(
          eq(campaign_stages.id, sid),
          eq(campaign_stages.campaign_id, cid),
          eq(campaign_stages.org_id, orgId),
        ),
      )
      .returning();
    if (row && salesDelta !== 0) {
      await tx.insert(stage_manual_sales).values({
        org_id: orgId,
        campaign_id: cid,
        stage_id: sid,
        delta: salesDelta,
        entered_by: auth.user.id,
      });
    }
    return row;
  });
  if (!updated) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "stage",
    });
  }
  return NextResponse.json(updated);
}
