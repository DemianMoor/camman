import {
  and,
  asc,
  desc,
  eq,
  ilike,
  ne,
  or,
  sql as drizzleSql,
} from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { provider_phones, sms_providers } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const SORT_COLUMNS = {
  name: sms_providers.name,
  sms_provider_id: sms_providers.sms_provider_id,
  created_at: sms_providers.created_at,
  status: sms_providers.status,
} as const;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "providers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);

  const conditions = [eq(sms_providers.org_id, orgId)];
  if (params.search) {
    const pattern = `%${params.search}%`;
    conditions.push(
      or(
        ilike(sms_providers.name, pattern),
        ilike(sms_providers.sms_provider_id, pattern),
      )!,
    );
  }
  if (!params.showArchived) {
    conditions.push(eq(sms_providers.status, "active"));
  }
  const where = and(...conditions);

  const sortKey = (params.sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? sms_providers.created_at;
  const orderFn = params.sortDir === "asc" ? asc : desc;

  // Phone count per provider: non-archived phones only.
  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: sms_providers.id,
        sms_provider_id: sms_providers.sms_provider_id,
        org_id: sms_providers.org_id,
        name: sms_providers.name,
        short_link_supported: sms_providers.short_link_supported,
        short_link_example: sms_providers.short_link_example,
        avatar_url: sms_providers.avatar_url,
        color: sms_providers.color,
        status: sms_providers.status,
        archived_at: sms_providers.archived_at,
        created_at: sms_providers.created_at,
        phone_count: drizzleSql<number>`count(${provider_phones.id})::int`,
      })
      .from(sms_providers)
      .leftJoin(
        provider_phones,
        and(
          eq(provider_phones.provider_id, sms_providers.id),
          ne(provider_phones.status, "archived"),
        ),
      )
      .where(where)
      .groupBy(sms_providers.id)
      .orderBy(orderFn(sortColumn))
      .limit(params.pageSize)
      .offset(params.page * params.pageSize),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(sms_providers)
      .where(where),
  ]);

  return NextResponse.json({
    data: rows,
    totalCount: countRows[0]?.count ?? 0,
    page: params.page,
    pageSize: params.pageSize,
  });
}
