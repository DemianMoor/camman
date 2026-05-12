import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  sql as drizzleSql,
} from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import {
  brands,
  opt_out_brands,
  opt_out_providers,
  opt_outs,
  sms_providers,
} from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const SORT_COLUMNS = {
  phone_number: opt_outs.phone_number,
  created_at: opt_outs.created_at,
  source: opt_outs.source,
} as const;

type BrandInfo = { id: number; name: string; color: string | null };
type ProviderInfo = { id: number; name: string; color: string | null };

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "opt_outs.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  const brandFilter = sp.get("brand_id");
  const brandFilterNum =
    brandFilter !== null && /^\d+$/.test(brandFilter) ? Number(brandFilter) : null;
  const providerFilterRaw = sp.get("provider_id");
  const providerFilterIds = providerFilterRaw
    ? providerFilterRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s))
        .map(Number)
    : [];

  const conditions = [eq(opt_outs.org_id, orgId)];
  if (params.search) {
    conditions.push(ilike(opt_outs.phone_number, `%${params.search}%`));
  }
  if (brandFilterNum !== null) {
    conditions.push(
      exists(
        db
          .select({ x: drizzleSql`1` })
          .from(opt_out_brands)
          .where(
            and(
              eq(opt_out_brands.opt_out_id, opt_outs.id),
              eq(opt_out_brands.brand_id, brandFilterNum),
            ),
          ),
      ),
    );
  }
  if (providerFilterIds.length > 0) {
    conditions.push(
      exists(
        db
          .select({ x: drizzleSql`1` })
          .from(opt_out_providers)
          .where(
            and(
              eq(opt_out_providers.opt_out_id, opt_outs.id),
              inArray(opt_out_providers.provider_id, providerFilterIds),
            ),
          ),
      ),
    );
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? opt_outs.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  const [pageRows, countRows] = await Promise.all([
    db
      .select()
      .from(opt_outs)
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(opt_outs)
      .where(where),
  ]);

  // Fetch joined brands/providers for the rows on this page (two small queries
  // are simpler than a single GROUP BY with array_agg).
  const ids = pageRows.map((r) => r.id);
  let brandsByOptOut = new Map<number, BrandInfo[]>();
  let providersByOptOut = new Map<number, ProviderInfo[]>();
  if (ids.length > 0) {
    const brandJoinRows = await db
      .select({
        opt_out_id: opt_out_brands.opt_out_id,
        id: brands.id,
        name: brands.name,
        color: brands.color,
      })
      .from(opt_out_brands)
      .innerJoin(brands, eq(brands.id, opt_out_brands.brand_id))
      .where(inArray(opt_out_brands.opt_out_id, ids));
    brandsByOptOut = brandJoinRows.reduce((acc, row) => {
      const list = acc.get(row.opt_out_id) ?? [];
      list.push({ id: row.id, name: row.name, color: row.color });
      acc.set(row.opt_out_id, list);
      return acc;
    }, new Map<number, BrandInfo[]>());

    const providerJoinRows = await db
      .select({
        opt_out_id: opt_out_providers.opt_out_id,
        id: sms_providers.id,
        name: sms_providers.name,
        color: sms_providers.color,
      })
      .from(opt_out_providers)
      .innerJoin(
        sms_providers,
        eq(sms_providers.id, opt_out_providers.provider_id),
      )
      .where(inArray(opt_out_providers.opt_out_id, ids));
    providersByOptOut = providerJoinRows.reduce((acc, row) => {
      const list = acc.get(row.opt_out_id) ?? [];
      list.push({ id: row.id, name: row.name, color: row.color });
      acc.set(row.opt_out_id, list);
      return acc;
    }, new Map<number, ProviderInfo[]>());
  }

  const data = pageRows.map((r) => ({
    ...r,
    brands: brandsByOptOut.get(r.id) ?? [],
    providers: providersByOptOut.get(r.id) ?? [],
  }));

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
