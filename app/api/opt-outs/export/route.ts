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
import {
  buildExportFilename,
  chunkedQuery,
  streamCsvResponse,
} from "@/lib/csv/stream-export";
import { can } from "@/lib/permissions";
import { formatPhoneForExport } from "@/lib/phone-validation";

const SORT_COLUMNS = {
  phone_number: opt_outs.phone_number,
  created_at: opt_outs.created_at,
  source: opt_outs.source,
} as const;

type Row = {
  id: number;
  phone_number: string;
  source: string | null;
  created_at: Date;
};

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
    brandFilter !== null && /^\d+$/.test(brandFilter)
      ? Number(brandFilter)
      : null;
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

  // Per-chunk we also pull the joined brand + provider names so the CSV can
  // include them on the row. Two lightweight queries per chunk beats trying
  // to GROUP BY/array_agg in the main query.
  async function fetchChunkWithJoins(
    offset: number,
    limit: number,
  ): Promise<(Row & { brand_names: string; provider_names: string })[]> {
    const pageRows = await db
      .select({
        id: opt_outs.id,
        phone_number: opt_outs.phone_number,
        source: opt_outs.source,
        created_at: opt_outs.created_at,
      })
      .from(opt_outs)
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(limit)
      .offset(offset);
    if (pageRows.length === 0) return [];

    const ids = pageRows.map((r) => r.id);
    const brandRows = await db
      .select({
        opt_out_id: opt_out_brands.opt_out_id,
        name: brands.name,
      })
      .from(opt_out_brands)
      .innerJoin(brands, eq(brands.id, opt_out_brands.brand_id))
      .where(inArray(opt_out_brands.opt_out_id, ids));
    const providerRows = await db
      .select({
        opt_out_id: opt_out_providers.opt_out_id,
        name: sms_providers.name,
      })
      .from(opt_out_providers)
      .innerJoin(
        sms_providers,
        eq(sms_providers.id, opt_out_providers.provider_id),
      )
      .where(inArray(opt_out_providers.opt_out_id, ids));

    const brandsByOptOut = new Map<number, string[]>();
    for (const r of brandRows) {
      const list = brandsByOptOut.get(r.opt_out_id) ?? [];
      list.push(r.name);
      brandsByOptOut.set(r.opt_out_id, list);
    }
    const providersByOptOut = new Map<number, string[]>();
    for (const r of providerRows) {
      const list = providersByOptOut.get(r.opt_out_id) ?? [];
      list.push(r.name);
      providersByOptOut.set(r.opt_out_id, list);
    }

    return pageRows.map((r) => ({
      ...r,
      brand_names: (brandsByOptOut.get(r.id) ?? []).join(", "),
      provider_names: (providersByOptOut.get(r.id) ?? []).join(", "),
    }));
  }

  const rowSource = chunkedQuery({ fetchChunk: fetchChunkWithJoins });

  return streamCsvResponse({
    filename: buildExportFilename("opt-outs"),
    columns: [
      { key: "phone_number", label: "Phone Number" },
      { key: "brands", label: "Brands" },
      { key: "providers", label: "Providers" },
      { key: "source", label: "Source" },
      { key: "created_at", label: "Created At" },
    ],
    rowSource,
    rowMapper: (row) => ({
      phone_number: formatPhoneForExport(row.phone_number),
      brands: row.brand_names,
      providers: row.provider_names,
      source: row.source ?? "",
      created_at: row.created_at,
    }),
  });
}
