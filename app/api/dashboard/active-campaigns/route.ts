import { and, desc, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { brands, campaign_stages, campaigns, offers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const LIMIT = 10;

// Active/paused campaigns ordered by most recent stage activity, with a
// per-status stage rollup. Used by the dashboard's Active Campaigns table.
//
// The "last_stage_sent_at" subquery sorts on the max sent_at of any stage
// (null when no stages have shipped yet). NULLS LAST ordering puts those
// at the bottom; tiebreak on created_at desc.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const rows = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      slug: campaigns.slug,
      human_id: campaigns.human_id,
      status: campaigns.status,
      assigned_to_user_id: campaigns.assigned_to_user_id,
      audience_snapshot_count: campaigns.audience_snapshot_count,
      created_at: campaigns.created_at,
      brand: {
        id: brands.id,
        name: brands.name,
        color: brands.color,
        avatar_url: brands.avatar_url,
      },
      offer: {
        id: offers.id,
        name: offers.name,
        color: offers.color,
        avatar_url: offers.avatar_url,
      },
      last_stage_sent_at: drizzleSql<string | null>`(
        select max(${campaign_stages.sent_at})
        from ${campaign_stages}
        where ${campaign_stages.campaign_id} = ${campaigns.id}
      )`,
    })
    .from(campaigns)
    .leftJoin(brands, eq(brands.id, campaigns.brand_id))
    .leftJoin(offers, eq(offers.id, campaigns.offer_id))
    .where(
      and(
        eq(campaigns.org_id, orgId),
        inArray(campaigns.status, ["active", "paused"]),
      ),
    )
    .orderBy(
      drizzleSql`(
        select max(${campaign_stages.sent_at})
        from ${campaign_stages}
        where ${campaign_stages.campaign_id} = ${campaigns.id}
      ) desc nulls last`,
      desc(campaigns.created_at),
    )
    .limit(LIMIT);

  if (rows.length === 0) {
    return NextResponse.json({ campaigns: [] });
  }

  // Per-status stage rollups in one query, then merge into rows.
  const campaignIds = rows.map((r) => r.id);
  const rollups = await db
    .select({
      campaign_id: campaign_stages.campaign_id,
      status: campaign_stages.status,
      count: drizzleSql<number>`count(*)::int`,
    })
    .from(campaign_stages)
    .where(inArray(campaign_stages.campaign_id, campaignIds))
    .groupBy(campaign_stages.campaign_id, campaign_stages.status);

  type Rollup = {
    draft: number;
    pending: number;
    sent: number;
    success: number;
    cancelled: number;
    failed: number;
    archived: number;
  };
  const rollupMap = new Map<number, Rollup>();
  for (const r of rollups) {
    if (!rollupMap.has(r.campaign_id)) {
      rollupMap.set(r.campaign_id, {
        draft: 0,
        pending: 0,
        sent: 0,
        success: 0,
        cancelled: 0,
        failed: 0,
        archived: 0,
      });
    }
    const ru = rollupMap.get(r.campaign_id)!;
    if (r.status in ru) (ru as Record<string, number>)[r.status] = r.count;
  }

  // Resolve assignee emails via auth.users (the auth schema isn't fully
  // mirrored in Drizzle — only id is). Same raw-SQL pattern as /api/members.
  const userIds = Array.from(
    new Set(
      rows
        .map((r) => r.assigned_to_user_id)
        .filter((v): v is string => !!v),
    ),
  );
  const userEmailMap = new Map<string, string | null>();
  if (userIds.length > 0) {
    const emailRows = (await db.execute(drizzleSql`
      select u.id, u.email
      from auth.users u
      inner join public.org_members om on om.user_id = u.id
      where om.org_id = ${orgId}::uuid
        and u.id in (${drizzleSql.raw(userIds.map((id) => `'${id}'::uuid`).join(","))})
    `)) as unknown as { id: string; email: string | null }[];
    for (const e of emailRows) userEmailMap.set(e.id, e.email);
  }

  const data = rows.map((r) => {
    const ru = rollupMap.get(r.id) ?? {
      draft: 0,
      pending: 0,
      sent: 0,
      success: 0,
      cancelled: 0,
      failed: 0,
      archived: 0,
    };
    const total =
      ru.draft + ru.pending + ru.sent + ru.success + ru.cancelled + ru.failed;
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      human_id: r.human_id,
      status: r.status as "active" | "paused",
      brand: r.brand?.id ? r.brand : null,
      offer: r.offer?.id ? r.offer : null,
      audience_snapshot_count: r.audience_snapshot_count,
      stage_count_total: total,
      stage_count_by_status: ru,
      last_stage_sent_at: r.last_stage_sent_at,
      assigned_to: r.assigned_to_user_id
        ? {
            id: r.assigned_to_user_id,
            email: userEmailMap.get(r.assigned_to_user_id) ?? null,
          }
        : null,
      created_at: r.created_at,
    };
  });

  return NextResponse.json({ campaigns: data });
}
