import { and, asc, desc, eq, ilike, sql as drizzleSql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const SORT_COLUMNS = {
  phone_number: contacts.phone_number,
  created_at: contacts.created_at,
} as const;

// Views are mutually exclusive filters driven by the stat tiles in the UI.
// active / archived map to is_archived; the three placeholder views resolve
// to empty until 6.2 wires up the join tables (opt_outs, opt_ins, clickers).
const VALID_VIEWS = new Set([
  "active",
  "archived",
  "opt_outs",
  "opt_ins",
  "clickers",
] as const);
const PLACEHOLDER_VIEWS = new Set(["opt_outs", "opt_ins", "clickers"]);

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contacts.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const rawView = req.nextUrl.searchParams.get("view") ?? "active";
  const view = (VALID_VIEWS as Set<string>).has(rawView) ? rawView : "active";

  // Placeholder views have no data source yet — short-circuit with empty
  // result rather than running a query whose result is guaranteed empty.
  if (PLACEHOLDER_VIEWS.has(view)) {
    return NextResponse.json({
      data: [],
      totalCount: 0,
      page: params.page,
      pageSize: params.pageSize,
      view,
      placeholder: true,
    });
  }

  const conditions = [eq(contacts.org_id, orgId)];
  if (params.search) {
    conditions.push(ilike(contacts.phone_number, `%${params.search}%`));
  }
  if (view === "active") {
    conditions.push(eq(contacts.is_archived, false));
  } else if (view === "archived") {
    conditions.push(eq(contacts.is_archived, true));
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? contacts.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  const [data, countRows] = await Promise.all([
    db
      .select()
      .from(contacts)
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(contacts)
      .where(where),
  ]);

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
    view,
  });
}
