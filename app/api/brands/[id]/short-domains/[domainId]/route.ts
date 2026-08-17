import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, short_domains } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import {
  deleteShortDomain,
  setShortDomainDefault,
  setShortDomainStatus,
} from "@/lib/sends/short-domain";

// Targeted per-domain operations — activate / deactivate / set-default / delete.
//
// ⚠️ EVERY operation here is keyed on the DOMAIN ROW's id. There is deliberately
// no brand-scoped mutation: the helper this replaced deleted by
// (org_id, brand_id), which post-0136 wiped every domain a brand had rather than
// the one being removed. scripts/verify-brand-domains.ts asserts at source level
// that no brand-keyed DELETE exists anywhere in the repo.
function parseId(v: string) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Resolve both ids together so a domain id from ANOTHER brand (or another org)
// can never be mutated through this route — the brand in the path must actually
// own the row.
async function resolveOwned(orgId: string, brandId: number, domainId: number) {
  const brand = await db
    .select({ id: brands.id })
    .from(brands)
    .where(and(eq(brands.id, brandId), eq(brands.org_id, orgId)))
    .limit(1);
  if (!brand[0]) return { brandMissing: true as const };

  const row = await db
    .select({ id: short_domains.id })
    .from(short_domains)
    .where(
      and(
        eq(short_domains.id, domainId),
        eq(short_domains.org_id, orgId),
        eq(short_domains.brand_id, brandId),
      ),
    )
    .limit(1);
  if (!row[0]) return { domainMissing: true as const };
  return { ok: true as const };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; domainId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "brands.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id, domainId: dParam } = await params;
  const brandId = parseId(id);
  const domainId = parseId(dParam);
  if (brandId === null || domainId === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }
  const owned = await resolveOwned(orgId, brandId, domainId);
  if ("brandMissing" in owned) {
    return apiError(404, "Brand not found", API_ERROR_CODES.NOT_FOUND, { entity: "brand" });
  }
  if ("domainMissing" in owned) {
    return apiError(404, "Short domain not found", API_ERROR_CODES.NOT_FOUND, { entity: "short_domain" });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const body = (json ?? {}) as { status?: unknown; is_default?: unknown };

  // Both in one request would be ambiguous about ordering (a set-default on a
  // row being deactivated is a contradiction), so require exactly one verb.
  const wantsStatus = body.status !== undefined;
  const wantsDefault = body.is_default !== undefined;
  if (wantsStatus === wantsDefault) {
    return apiError(
      400,
      "Send exactly one of `status` or `is_default`",
      API_ERROR_CODES.VALIDATION,
    );
  }

  if (wantsStatus) {
    if (body.status !== "active" && body.status !== "pending") {
      return apiError(
        400,
        "status must be 'active' or 'pending'",
        API_ERROR_CODES.VALIDATION,
        { field: "status" },
      );
    }
    const r = await setShortDomainStatus(db, { orgId, id: domainId, status: body.status });
    if (!r.ok) {
      return apiError(404, r.message, API_ERROR_CODES.NOT_FOUND, { entity: "short_domain" });
    }
    return NextResponse.json({ ...r });
  }

  if (body.is_default !== true) {
    return apiError(
      400,
      "is_default can only be set to true; make another domain the default instead of clearing this one",
      API_ERROR_CODES.VALIDATION,
      { field: "is_default" },
    );
  }
  const r = await db.transaction((tx) => setShortDomainDefault(tx, { orgId, id: domainId }));
  if (!r.ok) {
    return apiError(
      r.reason === "not_active" ? 409 : 404,
      r.message,
      r.reason === "not_active" ? API_ERROR_CODES.CONFLICT : API_ERROR_CODES.NOT_FOUND,
      { reason: r.reason },
    );
  }
  return NextResponse.json({ ...r });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; domainId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  // There is no `brands.delete` literal; removing a registry child is an UPDATE
  // to the brand, the same tier as adding one.
  if (!can(role, "brands.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id, domainId: dParam } = await params;
  const brandId = parseId(id);
  const domainId = parseId(dParam);
  if (brandId === null || domainId === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }
  const owned = await resolveOwned(orgId, brandId, domainId);
  if ("brandMissing" in owned) {
    return apiError(404, "Brand not found", API_ERROR_CODES.NOT_FOUND, { entity: "brand" });
  }
  if ("domainMissing" in owned) {
    return apiError(404, "Short domain not found", API_ERROR_CODES.NOT_FOUND, { entity: "short_domain" });
  }

  const r = await deleteShortDomain(db, { orgId, id: domainId });
  if (!r.ok) {
    return apiError(
      r.reason === "domain_in_use" ? 409 : 404,
      r.message,
      r.reason === "domain_in_use" ? API_ERROR_CODES.CONFLICT : API_ERROR_CODES.NOT_FOUND,
      { reason: r.reason },
    );
  }
  return NextResponse.json({ ...r });
}
