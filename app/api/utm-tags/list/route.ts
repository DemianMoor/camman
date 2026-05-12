import { and, asc, desc, eq, ilike, or, sql as drizzleSql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { affiliate_networks, utm_tags } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const SORT_COLUMNS = {
  label: utm_tags.label,
  tag_id: utm_tags.tag_id,
  value_source: utm_tags.value_source,
  created_at: utm_tags.created_at,
  status: utm_tags.status,
} as const;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "utm_tags.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const networkParam = req.nextUrl.searchParams.get("affiliate_network_id");
  const networkFilter =
    networkParam !== null && /^\d+$/.test(networkParam)
      ? Number(networkParam)
      : null;

  const conditions = [eq(utm_tags.org_id, orgId)];
  if (params.search) {
    const pattern = `%${params.search}%`;
    conditions.push(
      or(
        ilike(utm_tags.label, pattern),
        ilike(utm_tags.tag_id, pattern),
        ilike(utm_tags.value_source, pattern),
      )!,
    );
  }
  if (!params.showArchived) {
    conditions.push(eq(utm_tags.status, "active"));
  }
  if (networkFilter !== null) {
    conditions.push(eq(utm_tags.affiliate_network_id, networkFilter));
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? utm_tags.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: utm_tags.id,
        tag_id: utm_tags.tag_id,
        org_id: utm_tags.org_id,
        label: utm_tags.label,
        value_source: utm_tags.value_source,
        affiliate_network_id: utm_tags.affiliate_network_id,
        color: utm_tags.color,
        status: utm_tags.status,
        archived_at: utm_tags.archived_at,
        created_at: utm_tags.created_at,
        network: {
          id: affiliate_networks.id,
          name: affiliate_networks.name,
          color: affiliate_networks.color,
          avatar_url: affiliate_networks.avatar_url,
        },
      })
      .from(utm_tags)
      .leftJoin(
        affiliate_networks,
        eq(utm_tags.affiliate_network_id, affiliate_networks.id),
      )
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(utm_tags)
      .where(where),
  ]);

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
