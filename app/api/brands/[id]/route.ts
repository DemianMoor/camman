import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { applyBrandShortDomain } from "@/lib/sends/short-domain";
import { brandUpdateSchema, nullIfEmpty } from "@/lib/validators/brands";

class ShortDomainError extends Error {
  constructor(
    public status: number,
    public reason: string,
    message: string,
  ) {
    super(message);
  }
}

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// The brand's current short domain (from short_domains), for response shaping.
async function brandShortDomain(
  dbc: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  orgId: string,
  brandId: number,
): Promise<string | null> {
  const rows = (await dbc.execute(drizzleSql`
    SELECT domain FROM short_domains WHERE org_id = ${orgId} AND brand_id = ${brandId} LIMIT 1
  `)) as unknown as { domain: string }[];
  return rows[0]?.domain ?? null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "brands.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const brandId = parseId(id);
  if (brandId === null) {
    return apiError(400, "Invalid brand id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select()
    .from(brands)
    .where(and(eq(brands.id, brandId), eq(brands.org_id, orgId)))
    .limit(1);

  if (!rows[0]) {
    return apiError(404, "Brand not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "brand",
    });
  }
  return NextResponse.json({
    ...rows[0],
    short_domain: await brandShortDomain(db, orgId, brandId),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "brands.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const brandId = parseId(id);
  if (brandId === null) {
    return apiError(400, "Invalid brand id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = brandUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Drizzle's .set rejects entirely-empty objects, but the schema already
  // refuses those. Strip undefined keys so we don't overwrite with NULL.
  // For the three optional string fields, empty string means "clear it" → NULL.
  // short_domain lives in a separate table — pull it out of the brand-column
  // updates and handle it via the upsert helper.
  const { short_domain: shortDomainInput, ...brandFields } = parsed.data;

  const updates: Record<string, unknown> = {};
  const NULLABLE_OPTIONAL = new Set([
    "short_link_base",
    "website",
    "avatar_url",
    "color",
  ]);
  for (const [k, v] of Object.entries(brandFields)) {
    if (v === undefined) continue;
    updates[k] = NULLABLE_OPTIONAL.has(k) ? nullIfEmpty(v as string) : v;
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Apply brand-column updates if any; otherwise confirm the brand exists
      // (and is org-owned) so a short_domain-only change still 404s correctly.
      let row;
      if (Object.keys(updates).length > 0) {
        [row] = await tx
          .update(brands)
          .set(updates)
          .where(and(eq(brands.id, brandId), eq(brands.org_id, orgId)))
          .returning();
      } else {
        [row] = await tx
          .select()
          .from(brands)
          .where(and(eq(brands.id, brandId), eq(brands.org_id, orgId)))
          .limit(1);
      }
      if (!row) return null;

      if (shortDomainInput !== undefined) {
        const r = await applyBrandShortDomain(tx, {
          orgId,
          brandId,
          rawDomain: shortDomainInput,
        });
        if (!r.ok) {
          throw new ShortDomainError(
            r.reason === "invalid_domain" ? 400 : 409,
            r.reason,
            r.message,
          );
        }
      }
      return { ...row, short_domain: await brandShortDomain(tx, orgId, brandId) };
    });

    if (!result) {
      return apiError(404, "Brand not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "brand",
      });
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ShortDomainError) {
      return apiError(
        err.status,
        err.message,
        err.status === 409 ? API_ERROR_CODES.CONFLICT : API_ERROR_CODES.VALIDATION,
        { reason: err.reason },
      );
    }
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A brand with this brand_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "brand_id" },
      );
    }
    throw err;
  }
}
