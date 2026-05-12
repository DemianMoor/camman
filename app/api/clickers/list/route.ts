import { and, asc, desc, eq, ilike, sql as drizzleSql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { brands, clickers, offers, sms_providers } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const SORT_COLUMNS = {
  phone_number: clickers.phone_number,
  created_at: clickers.created_at,
} as const;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "clickers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  const brandFilter = sp.get("brand_id");
  const providerFilter = sp.get("provider_id");
  const offerFilter = sp.get("offer_id");

  const conditions = [eq(clickers.org_id, orgId)];
  if (params.search) {
    conditions.push(ilike(clickers.phone_number, `%${params.search}%`));
  }
  if (brandFilter !== null && /^\d+$/.test(brandFilter)) {
    conditions.push(eq(clickers.brand_id, Number(brandFilter)));
  }
  if (providerFilter !== null && /^\d+$/.test(providerFilter)) {
    conditions.push(eq(clickers.provider_id, Number(providerFilter)));
  }
  if (offerFilter !== null && /^\d+$/.test(offerFilter)) {
    conditions.push(eq(clickers.offer_id, Number(offerFilter)));
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? clickers.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  const [pageRows, countRows] = await Promise.all([
    db
      .select({
        id: clickers.id,
        org_id: clickers.org_id,
        contact_id: clickers.contact_id,
        phone_number: clickers.phone_number,
        brand_id: clickers.brand_id,
        provider_id: clickers.provider_id,
        provider_phone_id: clickers.provider_phone_id,
        offer_id: clickers.offer_id,
        source: clickers.source,
        created_at: clickers.created_at,
        brand: { id: brands.id, name: brands.name, color: brands.color },
        provider: {
          id: sms_providers.id,
          name: sms_providers.name,
          color: sms_providers.color,
        },
        offer: {
          id: offers.id,
          name: offers.name,
          color: offers.color,
        },
      })
      .from(clickers)
      .leftJoin(brands, eq(brands.id, clickers.brand_id))
      .leftJoin(sms_providers, eq(sms_providers.id, clickers.provider_id))
      .leftJoin(offers, eq(offers.id, clickers.offer_id))
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(clickers)
      .where(where),
  ]);

  const data = pageRows.map((r) => ({
    ...r,
    brand: r.brand && r.brand.id !== null ? r.brand : null,
    provider: r.provider && r.provider.id !== null ? r.provider : null,
    offer: r.offer && r.offer.id !== null ? r.offer : null,
  }));

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
