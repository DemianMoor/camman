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
  name: affiliate_networks.name,
  network_id: affiliate_networks.network_id,
  created_at: affiliate_networks.created_at,
  status: affiliate_networks.status,
} as const;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "networks.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);

  const conditions = [eq(affiliate_networks.org_id, orgId)];
  if (params.search) {
    const pattern = `%${params.search}%`;
    conditions.push(
      or(
        ilike(affiliate_networks.name, pattern),
        ilike(affiliate_networks.network_id, pattern),
      )!,
    );
  }
  if (!params.showArchived) {
    conditions.push(eq(affiliate_networks.status, "active"));
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? affiliate_networks.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  // Join offers (filtered to active) and count per network. LEFT JOIN ensures
  // networks with zero offers still appear with offer_count = 0.
  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: affiliate_networks.id,
        network_id: affiliate_networks.network_id,
        org_id: affiliate_networks.org_id,
        name: affiliate_networks.name,
        url: affiliate_networks.url,
        avatar_url: affiliate_networks.avatar_url,
        color: affiliate_networks.color,
        status: affiliate_networks.status,
        archived_at: affiliate_networks.archived_at,
        created_at: affiliate_networks.created_at,
        offer_count: drizzleSql<number>`count(${offers.id})::int`,
      })
      .from(affiliate_networks)
      .leftJoin(
        offers,
        and(
          eq(offers.network_id, affiliate_networks.id),
          eq(offers.status, "active"),
        ),
      )
      .where(where)
      .groupBy(affiliate_networks.id)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(affiliate_networks)
      .where(where),
  ]);

  return NextResponse.json({
    data: rows,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
