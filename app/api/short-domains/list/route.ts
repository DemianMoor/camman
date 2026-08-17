import { and, asc, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { short_domains } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// GET /api/short-domains/list?brand_id=<n>
//
// The short domains a sending number may be pointed at (migration 0137). Feeds
// the picker on the phone form; org-scoped, and brand-scoped when brand_id is
// supplied.
//
// Returns `status` per row rather than filtering to active only. The picker
// needs to SHOW a pending domain as unselectable-and-why: silently omitting it
// makes a domain the operator just added look like it failed to save, and they
// re-add it. The assignment guard (lib/providers/short-domain-assignment.ts) and
// kickoff both enforce active-only regardless of what this returns — this
// endpoint informs the UI, it is not the gate.
//
// Ordering matches kickoff's brand-default pick (created_at, id) so the first
// active row in this list is the one a number would fall back to.
export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  // Same bar as viewing provider numbers — this is registry metadata, no secrets.
  if (!can(role, "provider_phones.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const raw = req.nextUrl.searchParams.get("brand_id");
  let brandId: number | null = null;
  if (raw !== null && raw !== "") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      return apiError(400, "Invalid brand_id", API_ERROR_CODES.VALIDATION, { field: "brand_id" });
    }
    brandId = n;
  }

  const rows = await db
    .select({
      id: short_domains.id,
      domain: short_domains.domain,
      brand_id: short_domains.brand_id,
      status: short_domains.status,
    })
    .from(short_domains)
    .where(
      brandId === null
        ? eq(short_domains.org_id, orgId)
        : and(eq(short_domains.org_id, orgId), eq(short_domains.brand_id, brandId)),
    )
    .orderBy(asc(short_domains.created_at), asc(short_domains.id));

  return NextResponse.json({ data: rows });
}
