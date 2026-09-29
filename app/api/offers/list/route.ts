import {
  and,
  asc,
  desc,
  eq,
  ilike,
  or,
  sql as drizzleSql,
} from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import {
  affiliate_networks,
  offer_brands,
  offer_exposure_counts,
  offers,
} from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const SORT_COLUMNS = {
  name: offers.name,
  offer_id: offers.offer_id,
  created_at: offers.created_at,
  status: offers.status,
  payout_model: offers.payout_model,
} as const;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "offers/list",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "offers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  // Pickers load the whole active catalog in one page, so the cap sits above
  // the default 100 (callers ask for 200/500 and were silently truncated).
  const params = parseListParams(req, { maxPageSize: 500 });
  const sp = req.nextUrl.searchParams;
  const networkIdParam = sp.get("network_id");
  const networkFilter =
    networkIdParam !== null && /^\d+$/.test(networkIdParam)
      ? Number(networkIdParam)
      : null;
  const brandIdParam = sp.get("brand_id");
  const brandFilter =
    brandIdParam !== null && /^\d+$/.test(brandIdParam)
      ? Number(brandIdParam)
      : null;
  // Explicit status wins over showArchived (which means "all statuses").
  const statusParam = sp.get("status");
  const statusFilter =
    statusParam === "active" || statusParam === "archived"
      ? statusParam
      : null;

  const conditions = [eq(offers.org_id, orgId)];
  if (params.search) {
    const pattern = `%${params.search}%`;
    conditions.push(
      or(ilike(offers.name, pattern), ilike(offers.offer_id, pattern))!,
    );
  }
  if (statusFilter !== null) {
    conditions.push(eq(offers.status, statusFilter));
  } else if (!params.showArchived) {
    conditions.push(eq(offers.status, "active"));
  }
  if (networkFilter !== null) {
    conditions.push(eq(offers.network_id, networkFilter));
  }
  if (brandFilter !== null) {
    conditions.push(
      drizzleSql`EXISTS (SELECT 1 FROM ${offer_brands} WHERE ${offer_brands.org_id} = ${orgId} AND ${offer_brands.offer_id} = ${offers.id} AND ${offer_brands.brand_id} = ${brandFilter})`,
    );
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? offers.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: offers.id,
        offer_id: offers.offer_id,
        org_id: offers.org_id,
        name: offers.name,
        postfix: offers.postfix,
        base_url: offers.base_url,
        network_id: offers.network_id,
        payout_model: offers.payout_model,
        payout_cpa: offers.payout_cpa,
        payout_revshare: offers.payout_revshare,
        sales_pages: offers.sales_pages,
        avatar_url: offers.avatar_url,
        color: offers.color,
        status: offers.status,
        archived_at: offers.archived_at,
        created_at: offers.created_at,
        // Distinct leads already used for this offer (content-dedup counter,
        // migration 0086). Precomputed — single-row join, never COUNT(DISTINCT).
        distinct_contacts_used: drizzleSql<number>`coalesce(${offer_exposure_counts.distinct_contacts}, 0)::int`,
        // Brands this offer is assigned to (offer_brands, 0194). The campaign
        // editor + clickers upload filter their offer pickers on it.
        brand_ids: drizzleSql<number[]>`coalesce((SELECT array_agg(ob.brand_id ORDER BY ob.brand_id) FROM offer_brands ob WHERE ob.offer_id = "offers"."id" AND ob.org_id = ${orgId}), '{}')`,
        network: {
          id: affiliate_networks.id,
          name: affiliate_networks.name,
          avatar_url: affiliate_networks.avatar_url,
          color: affiliate_networks.color,
        },
      })
      .from(offers)
      .leftJoin(
        affiliate_networks,
        eq(offers.network_id, affiliate_networks.id),
      )
      .leftJoin(
        offer_exposure_counts,
        and(
          eq(offer_exposure_counts.offer_id, offers.id),
          eq(offer_exposure_counts.org_id, orgId),
        ),
      )
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(offers)
      .where(where),
  ]);

  // leftJoin emits {id: null, name: null, ...} for missing matches — flatten to null.
  const data = rows.map((r) => ({
    ...r,
    network: r.network && r.network.id !== null ? r.network : null,
  }));

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
