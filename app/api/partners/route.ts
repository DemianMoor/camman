import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { partners } from "@/db/schema";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, isUniqueViolation, requireApiMembership } from "@/lib/api/helpers";
import { listPartners, loadPartner } from "@/lib/partners/queries";
import { can } from "@/lib/permissions";
import { partnerCreateSchema } from "@/lib/validators/partners";

// Partners (partner attribution Phase 1, migration 0200): the entity above
// partner_keys — one row per commercial partner, owning the signed report link
// and the revenue toggle. Keys are nested in the list response so the
// Settings page is two queries, not N+1. Permission ids stay partner_keys.*
// (ruling Q9).
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "partner_keys.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  return NextResponse.json(await listPartners(orgId));
}

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;
  if (!can(role, "partner_keys.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = partnerCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION, {
      field: parsed.error.issues[0]?.path.join("."),
    });
  }

  try {
    const [row] = await db
      .insert(partners)
      .values({
        org_id: orgId,
        slug: parsed.data.slug,
        name: parsed.data.name,
        created_by: user.id,
      })
      .returning({ id: partners.id });
    return NextResponse.json(await loadPartner(orgId, row.id), { status: 201 });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return apiError(409, "A partner with that slug already exists", API_ERROR_CODES.DUPLICATE, {
        field: "slug",
      });
    }
    throw e;
  }
}
