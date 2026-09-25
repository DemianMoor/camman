import { and, asc, desc, eq, ilike, or, sql as drizzleSql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { contact_groups } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const SORT_COLUMNS = {
  name: contact_groups.name,
  contact_group_id: contact_groups.contact_group_id,
  created_at: contact_groups.created_at,
  status: contact_groups.status,
} as const;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "contact-groups/list",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  // Two kinds of caller. The Contact Groups screen needs `contact_groups.view`.
  // The campaign audience picker and the segment rule picker only need names to
  // choose from, so anyone who can build a campaign may list them — which is
  // what lets the operator fill the required Contact groups field. The
  // contact-level endpoint (`[id]/contacts`) stays denied to the operator in
  // lib/authz/route-map.ts.
  const fullView = can(role, "contact_groups.view");
  if (!fullView && !can(role, "campaigns.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);

  const conditions = [eq(contact_groups.org_id, orgId)];
  if (params.search) {
    const pattern = `%${params.search}%`;
    conditions.push(
      or(
        ilike(contact_groups.name, pattern),
        ilike(contact_groups.contact_group_id, pattern),
        // Picker-only callers can't see descriptions, so they can't search them
        // either — otherwise a search would reveal what a description says.
        ...(fullView ? [ilike(contact_groups.description, pattern)] : []),
      )!,
    );
  }
  if (!params.showArchived) {
    conditions.push(eq(contact_groups.status, "active"));
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? contact_groups.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: contact_groups.id,
        contact_group_id: contact_groups.contact_group_id,
        org_id: contact_groups.org_id,
        name: contact_groups.name,
        description: contact_groups.description,
        color: contact_groups.color,
        status: contact_groups.status,
        archived_at: contact_groups.archived_at,
        created_at: contact_groups.created_at,
        // Lifecycle override (migration 0187). NULL = inherit the org default.
        // Returned so the campaign form's Freeze note can show the effective
        // cadence of the SELECTED groups without a second round trip.
        freeze_cadence_days: contact_groups.freeze_cadence_days,
        // Distinct contacts that carry this tag. Replaces the previous
        // segment_count (count of segments in this group), which is moot
        // after the 0031 flip — groups are on contacts now, not segments.
        contact_count: drizzleSql<number>`(
          select count(*)::int
          from "contact_contact_groups" ccg
          where ccg."contact_group_id" = "contact_groups"."id"
        )`,
      })
      .from(contact_groups)
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(contact_groups)
      .where(where),
  ]);

  // Descriptions are free-text notes and can name where a list came from
  // ("Test group from Big Data group"). Picker-only callers don't get them.
  return NextResponse.json({
    data: fullView ? rows : rows.map((r) => ({ ...r, description: null })),
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
