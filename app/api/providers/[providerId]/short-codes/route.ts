import { and, asc, desc, eq, ilike, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, provider_short_codes, sms_providers } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { providerShortCodeCreateSchema } from "@/lib/validators/provider-short-codes";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const SORT_COLUMNS = {
  short_code: provider_short_codes.short_code,
  cost_per_sms: provider_short_codes.cost_per_sms,
  created_at: provider_short_codes.created_at,
  status: provider_short_codes.status,
} as const;

const VALID_STATUSES = new Set([
  "active",
  "suspended",
  "blocked",
  "archived",
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_short_codes.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId } = await params;
  const pid = parseId(providerId);
  if (pid === null) {
    return apiError(400, "Invalid provider id", API_ERROR_CODES.VALIDATION, {
      field: "providerId",
    });
  }

  const sp = req.nextUrl.searchParams;
  const statusParam = sp.get("status");
  const searchParam = sp.get("search")?.trim() ?? null;
  const sortBy = sp.get("sortBy");
  const sortDir = sp.get("sortDir") === "asc" ? "asc" : "desc";

  // status param is a comma-separated list; default excludes archived.
  const requestedStatuses = statusParam
    ? statusParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID_STATUSES.has(s))
    : ["active", "suspended", "blocked"];

  const conditions = [
    eq(provider_short_codes.org_id, orgId),
    eq(provider_short_codes.provider_id, pid),
    inArray(provider_short_codes.status, requestedStatuses),
  ];
  if (searchParam) {
    conditions.push(ilike(provider_short_codes.short_code, `%${searchParam}%`));
  }
  const where = and(...conditions);

  const sortKey = (sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? provider_short_codes.created_at;
  const orderFn = sortDir === "asc" ? asc : desc;

  const rows = await db
    .select({
      id: provider_short_codes.id,
      org_id: provider_short_codes.org_id,
      provider_id: provider_short_codes.provider_id,
      brand_id: provider_short_codes.brand_id,
      short_code: provider_short_codes.short_code,
      cost_per_sms: provider_short_codes.cost_per_sms,
      status: provider_short_codes.status,
      archived_at: provider_short_codes.archived_at,
      created_at: provider_short_codes.created_at,
      brand: {
        id: brands.id,
        name: brands.name,
        color: brands.color,
        avatar_url: brands.avatar_url,
      },
    })
    .from(provider_short_codes)
    .leftJoin(brands, eq(provider_short_codes.brand_id, brands.id))
    .where(where)
    .orderBy(orderFn(sortColumn));

  const data = rows.map((r) => ({
    ...r,
    brand: r.brand && r.brand.id !== null ? r.brand : null,
  }));

  return NextResponse.json({ data });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_short_codes.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId } = await params;
  const pid = parseId(providerId);
  if (pid === null) {
    return apiError(400, "Invalid provider id", API_ERROR_CODES.VALIDATION, {
      field: "providerId",
    });
  }

  // Verify provider exists in this org (adding short codes to an archived
  // provider is allowed; archiving doesn't lock the FK).
  const providerRows = await db
    .select({ id: sms_providers.id })
    .from(sms_providers)
    .where(and(eq(sms_providers.id, pid), eq(sms_providers.org_id, orgId)))
    .limit(1);
  if (!providerRows[0]) {
    return apiError(404, "Provider not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = providerShortCodeCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  try {
    const [created] = await db
      .insert(provider_short_codes)
      .values({
        org_id: orgId,
        provider_id: pid,
        brand_id: parsed.data.brand_id ?? null,
        short_code: parsed.data.short_code,
        cost_per_sms: String(parsed.data.cost_per_sms),
        status: "active",
      })
      .returning();
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "This short code already exists in your organization",
        API_ERROR_CODES.DUPLICATE,
        { field: "short_code" },
      );
    }
    throw err;
  }
}
