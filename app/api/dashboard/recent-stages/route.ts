import { and, desc, eq, isNotNull } from "drizzle-orm";
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
import { can } from "@/lib/permissions";

const LIMIT = 10;

// Recent stages with sent_at set, newest first. The dashboard shows these
// as a "what just shipped" feed. Per-status filtering isn't necessary —
// any stage that's ever been sent is interesting context, including
// cancelled / failed (which still have a sent_at because they reached
// that bucket at some point).
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
      sent_at: campaign_stages.sent_at,
      sms_count: campaign_stages.sms_count,
      delivered_count: campaign_stages.delivered_count,
      opt_out_count: campaign_stages.opt_out_count,
      click_count: campaign_stages.click_count,
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
        isNotNull(campaign_stages.sent_at),
      ),
    )
    .orderBy(desc(campaign_stages.sent_at))
    .limit(LIMIT);

  const data = rows.map((r) => ({
    id: r.id,
    stage_number: r.stage_number,
    label: r.label,
    status: r.status,
    sent_at: r.sent_at,
    sms_count: r.sms_count,
    delivered_count: r.delivered_count,
    opt_out_count: r.opt_out_count,
    click_count: r.click_count,
    total_cost: Number(r.total_cost),
    campaign: r.campaign,
    creative: r.creative?.id ? r.creative : null,
    brand: r.brand?.id ? r.brand : null,
  }));

  return NextResponse.json({ stages: data });
}
