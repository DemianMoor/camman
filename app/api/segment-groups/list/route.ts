import { and, asc, desc, eq, ilike, or, sql as drizzleSql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { segment_groups } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const SORT_COLUMNS = {
  name: segment_groups.name,
  segment_group_id: segment_groups.segment_group_id,
  created_at: segment_groups.created_at,
  status: segment_groups.status,
} as const;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segment_groups.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);

  const conditions = [eq(segment_groups.org_id, orgId)];
  if (params.search) {
    const pattern = `%${params.search}%`;
    conditions.push(
      or(
        ilike(segment_groups.name, pattern),
        ilike(segment_groups.segment_group_id, pattern),
        ilike(segment_groups.description, pattern),
      )!,
    );
  }
  if (!params.showArchived) {
    conditions.push(eq(segment_groups.status, "active"));
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? segment_groups.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: segment_groups.id,
        segment_group_id: segment_groups.segment_group_id,
        org_id: segment_groups.org_id,
        name: segment_groups.name,
        description: segment_groups.description,
        color: segment_groups.color,
        status: segment_groups.status,
        archived_at: segment_groups.archived_at,
        created_at: segment_groups.created_at,
        segment_count: drizzleSql<number>`(
          select count(*)::int
          from "segment_segment_groups" ssg
          inner join "segments" s on s."id" = ssg."segment_id"
          where ssg."segment_group_id" = "segment_groups"."id"
            and s."status" <> 'archived'
        )`,
      })
      .from(segment_groups)
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(segment_groups)
      .where(where),
  ]);

  const data = rows;

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
