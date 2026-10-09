import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { partners } from "@/db/schema";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { loadPartner } from "@/lib/partners/queries";
import { can } from "@/lib/permissions";

// Restore an archived partner (ruling Q7): intake on its keys and its report
// link come back in the same flip, because both read `partners.status`.
export const dynamic = "force-dynamic";

function parseId(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ partnerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "partner_keys.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const id = parseId((await params).partnerId);
  if (id === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "partnerId" });

  const updated = await db
    .update(partners)
    .set({ status: "active", archived_at: null })
    .where(and(eq(partners.id, id), eq(partners.org_id, orgId), eq(partners.status, "archived")))
    .returning({ id: partners.id });
  if (updated[0]) return NextResponse.json(await loadPartner(orgId, id));

  const existing = await loadPartner(orgId, id);
  if (!existing) return apiError(404, "Partner not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner" });
  return apiError(409, "Partner is not archived", API_ERROR_CODES.CONFLICT, { reason: "not_archived" });
}
