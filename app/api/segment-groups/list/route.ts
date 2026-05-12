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
      .select()
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

  // TODO(step-6): wire up real count when segments table exists. For now
  // hardcoded to 0 so the response shape is stable and the UI doesn't need
  // to change when segments land.
  const data = rows.map((r) => ({ ...r, segment_count: 0 }));

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
