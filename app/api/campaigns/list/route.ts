import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql as drizzleSql,
} from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { brands, campaigns, offers } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { CAMPAIGN_STATUSES } from "@/lib/validators/campaigns";

const SORT_COLUMNS = {
  created_at: campaigns.created_at,
  name: campaigns.name,
  start_date: campaigns.start_date,
  status: campaigns.status,
} as const;

const VALID_STATUSES = new Set<string>(CAMPAIGN_STATUSES);

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  const statusFilterRaw = sp.get("status");
  const statusFilter = statusFilterRaw
    ? statusFilterRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID_STATUSES.has(s))
    : [];
  const brandFilter = sp.get("brand_id");
  const offerFilter = sp.get("offer_id");
  const assignedFilter = sp.get("assigned_to_user_id");

  const conditions = [eq(campaigns.org_id, orgId)];
  if (params.search) {
    const pattern = `%${params.search}%`;
    conditions.push(
      or(
        ilike(campaigns.name, pattern),
        ilike(campaigns.human_id, pattern),
        ilike(campaigns.slug, pattern),
      )!,
    );
  }
  if (!params.showArchived && statusFilter.length === 0) {
    conditions.push(drizzleSql`${campaigns.status} <> 'archived'`);
  }
  if (statusFilter.length > 0) {
    conditions.push(inArray(campaigns.status, statusFilter));
  }
  if (brandFilter !== null && /^\d+$/.test(brandFilter)) {
    conditions.push(eq(campaigns.brand_id, Number(brandFilter)));
  }
  if (offerFilter !== null && /^\d+$/.test(offerFilter)) {
    conditions.push(eq(campaigns.offer_id, Number(offerFilter)));
  }
  if (assignedFilter !== null) {
    // Accept "unassigned" or a UUID. Anything else is ignored.
    if (assignedFilter === "unassigned") {
      conditions.push(drizzleSql`${campaigns.assigned_to_user_id} is null`);
    } else if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        assignedFilter,
      )
    ) {
      conditions.push(eq(campaigns.assigned_to_user_id, assignedFilter));
    }
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? campaigns.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: campaigns.id,
        org_id: campaigns.org_id,
        slug: campaigns.slug,
        human_id: campaigns.human_id,
        name: campaigns.name,
        notes: campaigns.notes,
        brand_id: campaigns.brand_id,
        offer_id: campaigns.offer_id,
        routing_type_id: campaigns.routing_type_id,
        traffic_type_id: campaigns.traffic_type_id,
        assigned_to_user_id: campaigns.assigned_to_user_id,
        created_by_user_id: campaigns.created_by_user_id,
        audience_segment_ids: campaigns.audience_segment_ids,
        audience_filters: campaigns.audience_filters,
        audience_snapshot_count: campaigns.audience_snapshot_count,
        start_date: campaigns.start_date,
        end_date: campaigns.end_date,
        status: campaigns.status,
        previous_status: campaigns.previous_status,
        status_changed_at: campaigns.status_changed_at,
        archived_at: campaigns.archived_at,
        created_at: campaigns.created_at,
        brand: { id: brands.id, name: brands.name, color: brands.color },
        offer: { id: offers.id, name: offers.name, color: offers.color },
      })
      .from(campaigns)
      .leftJoin(brands, eq(brands.id, campaigns.brand_id))
      .leftJoin(offers, eq(offers.id, campaigns.offer_id))
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(campaigns)
      .where(where),
  ]);

  const data = rows.map((r) => ({
    ...r,
    brand: r.brand && r.brand.id !== null ? r.brand : null,
    offer: r.offer && r.offer.id !== null ? r.offer : null,
  }));

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
