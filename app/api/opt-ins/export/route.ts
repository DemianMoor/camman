import { and, asc, desc, eq, ilike } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, opt_ins, sms_providers } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import {
  buildExportFilename,
  chunkedQuery,
  streamCsvResponse,
} from "@/lib/csv/stream-export";
import { can } from "@/lib/permissions";
import { formatPhoneForExport } from "@/lib/phone-validation";

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

  const rowSource = chunkedQuery({
    fetchChunk: (offset, limit) =>
      db
        .select({
          phone_number: opt_ins.phone_number,
          source: opt_ins.source,
          created_at: opt_ins.created_at,
          brand_name: brands.name,
          provider_name: sms_providers.name,
        })
        .from(opt_ins)
        .leftJoin(brands, eq(brands.id, opt_ins.brand_id))
        .leftJoin(sms_providers, eq(sms_providers.id, opt_ins.provider_id))
        .where(where)
        .orderBy(orderFn(sortColumn))
        .limit(limit)
        .offset(offset),
  });

  return streamCsvResponse({
    filename: buildExportFilename("opt-ins"),
    columns: [
      { key: "phone_number", label: "Phone Number" },
      { key: "brand", label: "Brand" },
      { key: "provider", label: "Provider" },
      { key: "source", label: "Source" },
      { key: "created_at", label: "Created At" },
    ],
    rowSource,
    rowMapper: (row) => ({
      phone_number: formatPhoneForExport(row.phone_number),
      brand: row.brand_name ?? "",
      provider: row.provider_name ?? "",
      source: row.source ?? "",
      created_at: row.created_at,
    }),
  });
}
