import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { addShortDomain, listBrandShortDomains } from "@/lib/sends/short-domain";

// The brand short-domain management surface (B1). Replaces the one-row upsert
// that used to hang off the brand form — brand domains are list-shaped since
// migration 0136, and a single text field cannot express a list.
//
// Nested under the existing `[id]` segment rather than `[brandId]`: Next.js
// forbids sibling dynamic segments with different names, and app/api/brands
// already uses `[id]`.
function parseId(v: string) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function ownedBrand(orgId: string, brandId: number) {
  const rows = await db
    .select({ id: brands.id })
    .from(brands)
    .where(and(eq(brands.id, brandId), eq(brands.org_id, orgId)))
    .limit(1);
  return rows[0] ?? null;
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
    return apiError(400, "Invalid brand id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }
  if (!(await ownedBrand(orgId, brandId))) {
    return apiError(404, "Brand not found", API_ERROR_CODES.NOT_FOUND, { entity: "brand" });
  }

  return NextResponse.json({ data: await listBrandShortDomains(db, { orgId, brandId }) });
}

// POST — ADD a domain. Always lands `pending`; activation is a separate,
// deliberate act (see PATCH on the child route).
export async function POST(
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
    return apiError(400, "Invalid brand id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }
  if (!(await ownedBrand(orgId, brandId))) {
    return apiError(404, "Brand not found", API_ERROR_CODES.NOT_FOUND, { entity: "brand" });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const domain = (json as { domain?: unknown } | null)?.domain;
  if (typeof domain !== "string") {
    return apiError(400, "domain is required", API_ERROR_CODES.VALIDATION, { field: "domain" });
  }

  const r = await addShortDomain(db, { orgId, brandId, rawDomain: domain });
  if (!r.ok) {
    // A taken hostname is a CONFLICT, never a silent adoption: the row belongs
    // to whichever brand registered it, and quietly taking it over would move
    // that brand's minting.
    return apiError(
      r.reason === "domain_taken" ? 409 : 400,
      r.message,
      r.reason === "domain_taken" ? API_ERROR_CODES.CONFLICT : API_ERROR_CODES.VALIDATION,
      { reason: r.reason },
    );
  }
  return NextResponse.json({ ...r }, { status: 201 });
}
