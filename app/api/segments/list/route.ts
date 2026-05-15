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
import { segment_stats, segments } from "@/db/schema";
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

// Segments no longer carry group membership (groups are on contacts now,
// not on segments). The list payload omits the previous `segment_groups`
// aggregation; the `?segment_group_id=` query param is also gone.
export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segments.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  // "Has rules" filter: "with" / "without" / null (all). Replaces the
  // segment_group_id filter that's gone after 0031.
  const hasRulesParam = sp.get("has_rules");
  const hasRulesFilter =
    hasRulesParam === "with"
      ? "with"
      : hasRulesParam === "without"
        ? "without"
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
  if (hasRulesFilter === "with") {
    conditions.push(
      drizzleSql`exists (select 1 from segment_rules sr where sr.segment_id = ${segments.id} and sr.is_active = true)`,
    );
  } else if (hasRulesFilter === "without") {
    conditions.push(
      drizzleSql`not exists (select 1 from segment_rules sr where sr.segment_id = ${segments.id} and sr.is_active = true)`,
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
        exclude_in_use_contacts: segments.exclude_in_use_contacts,
        stats: {
          total_count: segment_stats.total_count,
          opt_out_count: segment_stats.opt_out_count,
          opt_in_count: segment_stats.opt_in_count,
          clicker_count: segment_stats.clicker_count,
          rule_filtered_count: segment_stats.rule_filtered_count,
          updated_at: segment_stats.updated_at,
        },
        active_rules_count: drizzleSql<number>`(
          select count(*)::int from segment_rules
          where segment_rules.segment_id = ${segments.id}
            and segment_rules.is_active = true
        )`,
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
      rule_filtered_count: null,
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
