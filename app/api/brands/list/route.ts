import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  or,
  sql as drizzleSql,
} from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { brands, short_domains } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const SORT_COLUMNS = {
  name: brands.name,
  brand_id: brands.brand_id,
  created_at: brands.created_at,
  status: brands.status,
} as const;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "brands.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);

  const conditions = [eq(brands.org_id, orgId)];
  if (params.search) {
    const pattern = `%${params.search}%`;
    conditions.push(
      or(ilike(brands.name, pattern), ilike(brands.brand_id, pattern))!,
    );
  }
  if (!params.showArchived) {
    conditions.push(eq(brands.status, "active"));
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? brands.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  const [data, countRows] = await Promise.all([
    // short_domain comes via LEFT JOIN, not a correlated sub-select: when the
    // outer query has a single FROM table, Drizzle renders `${brands.id}`
    // inside a raw sql sub-select as the bare, unqualified `"id"`, which then
    // binds to the SUBQUERY's own table (short_domains.id) and silently returns
    // null. The join condition is always table-qualified, and the
    // `short_domains_brand_id_uniq` index guarantees ≤1 row per brand.
    db
      .select({
        ...getTableColumns(brands),
        short_domain: short_domains.domain,
      })
      .from(brands)
      .leftJoin(short_domains, eq(short_domains.brand_id, brands.id))
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(brands)
      .where(where),
  ]);

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
