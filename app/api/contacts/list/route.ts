import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  sql as drizzleSql,
} from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { clickers, contacts, opt_ins, opt_outs } from "@/db/schema";
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
// active / archived map to is_archived; opt_outs / opt_ins / clickers filter
// to contacts that appear in the respective tables.
const VALID_VIEWS = new Set([
  "active",
  "archived",
  "opt_outs",
  "opt_ins",
  "clickers",
] as const);

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

  const conditions = [eq(contacts.org_id, orgId)];
  if (params.search) {
    conditions.push(ilike(contacts.phone_number, `%${params.search}%`));
  }
  if (view === "active") {
    conditions.push(eq(contacts.is_archived, false));
  } else if (view === "archived") {
    conditions.push(eq(contacts.is_archived, true));
  } else if (view === "opt_outs") {
    // Active contacts that have at least one opt_out record.
    conditions.push(eq(contacts.is_archived, false));
    conditions.push(
      exists(
        db
          .select({ x: drizzleSql`1` })
          .from(opt_outs)
          .where(
            and(
              eq(opt_outs.contact_id, contacts.id),
              eq(opt_outs.org_id, orgId),
            ),
          ),
      ),
    );
  } else if (view === "opt_ins") {
    conditions.push(eq(contacts.is_archived, false));
    conditions.push(
      exists(
        db
          .select({ x: drizzleSql`1` })
          .from(opt_ins)
          .where(
            and(
              eq(opt_ins.contact_id, contacts.id),
              eq(opt_ins.org_id, orgId),
            ),
          ),
      ),
    );
  } else if (view === "clickers") {
    conditions.push(eq(contacts.is_archived, false));
    conditions.push(
      exists(
        db
          .select({ x: drizzleSql`1` })
          .from(clickers)
          .where(
            and(
              eq(clickers.contact_id, contacts.id),
              eq(clickers.org_id, orgId),
            ),
          ),
      ),
    );
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
