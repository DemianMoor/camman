import { and, eq } from "drizzle-orm";
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
import { brandUpdateSchema, nullIfEmpty } from "@/lib/validators/brands";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
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
  return NextResponse.json(rows[0]);
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
  const updates: Record<string, unknown> = {};
  const NULLABLE_OPTIONAL = new Set([
    "short_link_base",
    "avatar_url",
    "color",
  ]);
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    updates[k] = NULLABLE_OPTIONAL.has(k) ? nullIfEmpty(v as string) : v;
  }

  try {
    const updated = await db
      .update(brands)
      .set(updates)
      .where(and(eq(brands.id, brandId), eq(brands.org_id, orgId)))
      .returning();

    if (!updated[0]) {
      return apiError(404, "Brand not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "brand",
      });
    }
    return NextResponse.json(updated[0]);
  } catch (err) {
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
