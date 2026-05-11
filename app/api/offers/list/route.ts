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
import { affiliate_networks, offers } from "@/db/schema";
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
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "offers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const networkIdParam = req.nextUrl.searchParams.get("network_id");
  const networkFilter =
    networkIdParam !== null && /^\d+$/.test(networkIdParam)
      ? Number(networkIdParam)
      : null;

  const conditions = [eq(offers.org_id, orgId)];
  if (params.search) {
    const pattern = `%${params.search}%`;
    conditions.push(
      or(ilike(offers.name, pattern), ilike(offers.offer_id, pattern))!,
    );
  }
  if (!params.showArchived) {
    conditions.push(eq(offers.status, "active"));
  }
  if (networkFilter !== null) {
    conditions.push(eq(offers.network_id, networkFilter));
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
