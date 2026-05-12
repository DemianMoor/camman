import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql as drizzleSql,
} from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { brands, creatives, offers, sms_providers } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { CREATIVE_STATUSES } from "@/lib/validators/creatives";

const SORT_COLUMNS = {
  created_at: creatives.created_at,
  status: creatives.status,
  text: creatives.text,
} as const;

const VALID_STATUSES = new Set<string>(CREATIVE_STATUSES);

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "creatives.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  const offerFilter = sp.get("offer_id");
  const providerFilter = sp.get("sms_provider_id");
  const brandFilter = sp.get("brand_id");
  const statusFilterRaw = sp.get("status");
  const statusFilter = statusFilterRaw
    ? statusFilterRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID_STATUSES.has(s))
    : [];

  const conditions = [eq(creatives.org_id, orgId)];
  if (params.search) {
    const pattern = `%${params.search}%`;
    conditions.push(
      or(
        ilike(creatives.text, pattern),
        ilike(creatives.creative_id, pattern),
      )!,
    );
  }
  if (!params.showArchived) {
    // Without an explicit status filter we hide archived rows; if statusFilter
    // explicitly includes "archived" we honor that.
    if (statusFilter.length === 0) {
      conditions.push(drizzleSql`${creatives.status} <> 'archived'`);
    }
  }
  if (statusFilter.length > 0) {
    conditions.push(inArray(creatives.status, statusFilter));
  }
  if (offerFilter !== null && /^\d+$/.test(offerFilter)) {
    conditions.push(eq(creatives.offer_id, Number(offerFilter)));
  }
  if (providerFilter !== null && /^\d+$/.test(providerFilter)) {
    conditions.push(eq(creatives.sms_provider_id, Number(providerFilter)));
  }
  if (brandFilter !== null && /^\d+$/.test(brandFilter)) {
    conditions.push(eq(creatives.brand_id, Number(brandFilter)));
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? creatives.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: creatives.id,
        creative_id: creatives.creative_id,
        slug: creatives.slug,
        org_id: creatives.org_id,
        offer_id: creatives.offer_id,
        sms_provider_id: creatives.sms_provider_id,
        brand_id: creatives.brand_id,
        text: creatives.text,
        status: creatives.status,
        archived_at: creatives.archived_at,
        created_at: creatives.created_at,
        offer: {
          id: offers.id,
          name: offers.name,
          color: offers.color,
        },
        provider: {
          id: sms_providers.id,
          name: sms_providers.name,
          color: sms_providers.color,
        },
        brand: {
          id: brands.id,
          name: brands.name,
          color: brands.color,
        },
      })
      .from(creatives)
      .leftJoin(offers, eq(offers.id, creatives.offer_id))
      .leftJoin(sms_providers, eq(sms_providers.id, creatives.sms_provider_id))
      .leftJoin(brands, eq(brands.id, creatives.brand_id))
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(creatives)
      .where(where),
  ]);

  // TODO(step-7.2): wire campaign_count to real data once campaigns exist.
  const data = rows.map((r) => ({
    ...r,
    offer: r.offer && r.offer.id !== null ? r.offer : null,
    provider: r.provider && r.provider.id !== null ? r.provider : null,
    brand: r.brand && r.brand.id !== null ? r.brand : null,
    campaign_count: 0,
  }));

  return NextResponse.json({
    data,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
