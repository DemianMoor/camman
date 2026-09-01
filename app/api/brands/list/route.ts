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
  const auth = await requireApiMembership({
    route: "brands/list",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "brands.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);

  // The brand's EFFECTIVE short domain, as a LATERAL sub-select so it yields at
  // most one row per brand by construction (see the note on the join below).
  // Correlates on brands.id/brands.org_id, which LATERAL makes legal.
  const effectiveDomain = db
    .select({ domain: short_domains.domain })
    .from(short_domains)
    .where(
      and(
        eq(short_domains.brand_id, brands.id),
        eq(short_domains.org_id, brands.org_id),
        eq(short_domains.status, "active"),
      ),
    )
    .orderBy(desc(short_domains.is_default), asc(short_domains.created_at), asc(short_domains.id))
    .limit(1)
    .as("effective_domain");

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
    // ⚠️ LATERAL … LIMIT 1, not a plain LEFT JOIN.
    //
    // This was `.leftJoin(short_domains, eq(short_domains.brand_id, brands.id))`,
    // whose one-row-per-brand property rested on the `short_domains_brand_id_uniq`
    // index — which migration 0136 DROPPED so a brand could hold several
    // domains. From that moment the join FANNED OUT: Guide Kin (2 domain rows)
    // came back TWICE, so it appeared twice in every brand dropdown in the app,
    // `data.length` (4) disagreed with `totalCount` (3), and LIMIT/OFFSET paged
    // over duplicated rows so a brand could be dropped from a later page.
    //
    // A correlated sub-select is NOT usable here: with a single FROM table
    // Drizzle renders `${brands.id}` as the bare, unqualified `"id"`, which
    // binds to the sub-select's own table and silently returns null. (That is
    // why the original comment reached for a join at all.) LATERAL fixes both
    // problems at once — it adds a second relation, so the correlation is
    // table-qualified, and LIMIT 1 makes the cardinality structural rather than
    // dependent on an index that can be dropped again.
    //
    // The row it picks is the EFFECTIVE domain — active only, explicit brand
    // default first, then the oldest — matching resolveShortDomainForSend's
    // brand-level precedence and the single-brand GET. The old join had NO
    // status filter, so post-B1 it could hand a `pending` host to the campaign
    // form's SMS preview; active-only is what makes this column mean what its
    // consumers assume.
    db
      .select({
        ...getTableColumns(brands),
        short_domain: effectiveDomain.domain,
      })
      .from(brands)
      .leftJoinLateral(effectiveDomain, drizzleSql`true`)
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
