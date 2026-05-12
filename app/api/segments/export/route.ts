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
import {
  buildExportFilename,
  chunkedQuery,
  streamCsvResponse,
} from "@/lib/csv/stream-export";
import { can } from "@/lib/permissions";

// Aggregate joined groups for each segment. Literal SQL aliases (not Drizzle
// ${column} interpolation) — same rationale as the list endpoint: the raw
// template tag doesn't qualify columns and ambiguity can arise.
const groupsAggSql = drizzleSql<
  string
>`(
  select coalesce(string_agg(sg."name", ', ' order by sg."name"), '')
  from "segment_segment_groups" ssg
  inner join "segment_groups" sg
    on sg."id" = ssg."segment_group_id"
  where ssg."segment_id" = "segments"."id"
)`;

const SORT_COLUMNS = {
  name: segments.name,
  segment_id: segments.segment_id,
  created_at: segments.created_at,
  status: segments.status,
} as const;

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

  const rowSource = chunkedQuery({
    fetchChunk: (offset, limit) =>
      db
        .select({
          name: segments.name,
          segment_id: segments.segment_id,
          status: segments.status,
          created_at: segments.created_at,
          groups: groupsAggSql,
          total_count: segment_stats.total_count,
          opt_out_count: segment_stats.opt_out_count,
          opt_in_count: segment_stats.opt_in_count,
          clicker_count: segment_stats.clicker_count,
        })
        .from(segments)
        .leftJoin(segment_stats, eq(segments.id, segment_stats.segment_id))
        .where(where)
        .orderBy(orderFn(sortColumn))
        .limit(limit)
        .offset(offset),
  });

  return streamCsvResponse({
    filename: buildExportFilename("segments"),
    columns: [
      { key: "name", label: "Segment Name" },
      { key: "segment_id", label: "Segment ID" },
      { key: "groups", label: "Groups" },
      { key: "total_count", label: "Total Contacts" },
      { key: "opt_out_count", label: "Opt-Out Count" },
      { key: "opt_in_count", label: "Opt-In Count" },
      { key: "clicker_count", label: "Clicker Count" },
      { key: "status", label: "Status" },
      { key: "created_at", label: "Created At" },
    ],
    rowSource,
    rowMapper: (row) => ({
      name: row.name,
      segment_id: row.segment_id,
      groups: row.groups ?? "",
      total_count: row.total_count ?? 0,
      opt_out_count: row.opt_out_count ?? 0,
      opt_in_count: row.opt_in_count ?? 0,
      clicker_count: row.clicker_count ?? 0,
      status: row.status,
      created_at: row.created_at,
    }),
  });
}
