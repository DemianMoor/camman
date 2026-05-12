import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  or,
  sql as drizzleSql,
} from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import {
  segment_segment_groups,
  segment_stats,
  segments,
} from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const SORT_COLUMNS = {
  name: segments.name,
  segment_id: segments.segment_id,
  created_at: segments.created_at,
  status: segments.status,
} as const;

// Correlated subquery returning the joined groups for each segment row.
// Uses literal SQL aliases because Drizzle's ${column} interpolation inside
// raw template strings emits the column name without a table prefix —
// which causes column-reference ambiguity when two tables in scope share
// column names (segments.segment_id text slug vs the junction's segment_id
// integer FK, etc).
const groupsAggSql = drizzleSql<
  { id: number; name: string; color: string | null }[]
>`(
  select coalesce(json_agg(json_build_object(
    'id', sg."id",
    'name', sg."name",
    'color', sg."color"
  ) order by sg."name"), '[]'::json)
  from "segment_segment_groups" ssg
  inner join "segment_groups" sg
    on sg."id" = ssg."segment_group_id"
  where ssg."segment_id" = "segments"."id"
)`;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segments.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  const segmentGroupIdRaw = sp.get("segment_group_id");
  const segmentGroupId =
    segmentGroupIdRaw && /^\d+$/.test(segmentGroupIdRaw)
      ? Number(segmentGroupIdRaw)
      : null;

  const conditions = [eq(segments.org_id, orgId)];
  if (params.search) {
    const pattern = `%${params.search}%`;
    conditions.push(
      or(
        ilike(segments.name, pattern),
        ilike(segments.segment_id, pattern),
        ilike(segments.original_name, pattern),
      )!,
    );
  }
  if (!params.showArchived) {
    conditions.push(eq(segments.status, "active"));
  }
  if (segmentGroupId !== null) {
    conditions.push(
      exists(
        db
          .select({ x: drizzleSql`1` })
          .from(segment_segment_groups)
          .where(
            and(
              eq(segment_segment_groups.segment_id, segments.id),
              eq(segment_segment_groups.segment_group_id, segmentGroupId),
            ),
          ),
      ),
    );
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? segments.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: segments.id,
        segment_id: segments.segment_id,
        org_id: segments.org_id,
        name: segments.name,
        original_name: segments.original_name,
        status: segments.status,
        archived_at: segments.archived_at,
        created_at: segments.created_at,
        segment_groups: groupsAggSql,
        stats: {
          total_count: segment_stats.total_count,
          opt_out_count: segment_stats.opt_out_count,
          opt_in_count: segment_stats.opt_in_count,
          clicker_count: segment_stats.clicker_count,
          updated_at: segment_stats.updated_at,
        },
      })
      .from(segments)
      .leftJoin(segment_stats, eq(segments.id, segment_stats.segment_id))
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(segments)
      .where(where),
  ]);

  const data = rows.map((r) => ({
    ...r,
    stats: r.stats ?? {
      total_count: 0,
      opt_out_count: 0,
      opt_in_count: 0,
      clicker_count: 0,
      updated_at: null,
    },
  }));

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
