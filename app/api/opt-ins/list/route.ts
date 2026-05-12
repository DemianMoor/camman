import { and, asc, desc, eq, ilike, sql as drizzleSql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { brands, opt_ins, sms_providers } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const SORT_COLUMNS = {
  phone_number: opt_ins.phone_number,
  created_at: opt_ins.created_at,
} as const;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "opt_ins.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  const brandFilter = sp.get("brand_id");
  const providerFilter = sp.get("provider_id");

  const conditions = [eq(opt_ins.org_id, orgId)];
  if (params.search) {
    conditions.push(ilike(opt_ins.phone_number, `%${params.search}%`));
  }
  if (brandFilter !== null && /^\d+$/.test(brandFilter)) {
    conditions.push(eq(opt_ins.brand_id, Number(brandFilter)));
  }
  if (providerFilter !== null && /^\d+$/.test(providerFilter)) {
    conditions.push(eq(opt_ins.provider_id, Number(providerFilter)));
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? opt_ins.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  const [pageRows, countRows] = await Promise.all([
    db
      .select({
        id: opt_ins.id,
        org_id: opt_ins.org_id,
        contact_id: opt_ins.contact_id,
        phone_number: opt_ins.phone_number,
        brand_id: opt_ins.brand_id,
        provider_id: opt_ins.provider_id,
        source: opt_ins.source,
        created_at: opt_ins.created_at,
        brand: {
          id: brands.id,
          name: brands.name,
          color: brands.color,
        },
        provider: {
          id: sms_providers.id,
          name: sms_providers.name,
          color: sms_providers.color,
        },
      })
      .from(opt_ins)
      .leftJoin(brands, eq(brands.id, opt_ins.brand_id))
      .leftJoin(sms_providers, eq(sms_providers.id, opt_ins.provider_id))
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(opt_ins)
      .where(where),
  ]);

  const data = pageRows.map((r) => ({
    ...r,
    brand: r.brand && r.brand.id !== null ? r.brand : null,
    provider: r.provider && r.provider.id !== null ? r.provider : null,
  }));

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
