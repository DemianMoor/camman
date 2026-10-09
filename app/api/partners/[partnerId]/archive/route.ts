import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { partners } from "@/db/schema";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { loadPartner } from "@/lib/partners/queries";
import { can } from "@/lib/permissions";

// Archive a partner (ruling Q7): intake stops on every key it owns and its
// report link stops resolving — both read `partners.status`, so the keys'
// own status is NOT touched and restore is one flip back. Nothing is deleted.
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
    .set({ status: "archived", archived_at: drizzleSql`now()` })
    .where(and(eq(partners.id, id), eq(partners.org_id, orgId), eq(partners.status, "active")))
    .returning({ id: partners.id });
  if (updated[0]) return NextResponse.json(await loadPartner(orgId, id));

  // Either the partner is not in this org or it was already archived.
  const existing = await loadPartner(orgId, id);
  if (!existing) return apiError(404, "Partner not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner" });
  return apiError(409, "Partner is already archived", API_ERROR_CODES.CONFLICT, { reason: "already_archived" });
}
