import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import {
  brands,
  campaign_stages,
  campaigns,
  creatives,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { stageSentCountSql } from "@/lib/stages/derived-counts";
import { can } from "@/lib/permissions";

const LIMIT = 10;

// Active stages — those still in flight. "Active" = status draft / pending /
// sent; success / cancelled / failed are considered completed and excluded
// (archived stages too). Ordered by most recently touched (status_changed_at),
// so the freshest work surfaces first. Counters are shown as context — drafts
// and pending stages typically have none yet.
const ACTIVE_STATUSES = ["draft", "pending", "sent"] as const;

export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const rows = await db
    .select({
      id: campaign_stages.id,
      stage_number: campaign_stages.stage_number,
      label: campaign_stages.label,
      status: campaign_stages.status,
      updated_at: campaign_stages.status_changed_at,
      sms_count: campaign_stages.sms_count,
      delivered_count: campaign_stages.delivered_count,
      // Real dispatched rows (stage_sends.status='sent'); combined with the
      // manual columns below so tracked stages don't read as 0.
      sent_count: stageSentCountSql,
      opt_out_count: campaign_stages.opt_out_count,
      click_count: campaign_stages.click_count,
      scrubbed_count: campaign_stages.scrubbed_count,
      bounced_count: campaign_stages.bounced_count,
      total_cost: campaign_stages.total_cost,
      campaign: {
        id: campaigns.id,
        name: campaigns.name,
        slug: campaigns.slug,
        status: campaigns.status,
        brand_id: campaigns.brand_id,
      },
      creative: {
        id: creatives.id,
        slug: creatives.slug,
        text: creatives.text,
      },
      brand: {
        id: brands.id,
        name: brands.name,
        color: brands.color,
        avatar_url: brands.avatar_url,
      },
    })
    .from(campaign_stages)
    .innerJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
    .leftJoin(creatives, eq(creatives.id, campaign_stages.creative_id))
    .leftJoin(brands, eq(brands.id, campaigns.brand_id))
    .where(
      and(
        eq(campaign_stages.org_id, orgId),
        isNull(campaign_stages.archived_at),
        inArray(campaign_stages.status, ACTIVE_STATUSES as unknown as string[]),
      ),
    )
    .orderBy(desc(campaign_stages.status_changed_at))
    .limit(LIMIT);

  const data = rows.map((r) => ({
    id: r.id,
    stage_number: r.stage_number,
    label: r.label,
    status: r.status,
    updated_at: r.updated_at,
    // Displayed sms/delivered = max(manual tally, real dispatched rows). No DLR,
    // so "sent" is the delivered proxy. See lib/stages/derived-counts.ts.
    sms_count: Math.max(r.sms_count, r.sent_count),
    delivered_count: Math.max(r.delivered_count, r.sent_count),
    opt_out_count: r.opt_out_count,
    click_count: r.click_count,
    scrubbed_count: r.scrubbed_count,
    bounced_count: r.bounced_count,
    total_cost: Number(r.total_cost),
    campaign: r.campaign,
    creative: r.creative?.id ? r.creative : null,
    brand: r.brand?.id ? r.brand : null,
  }));

  return NextResponse.json({ stages: data });
}
