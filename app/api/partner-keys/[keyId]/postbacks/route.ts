import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { partner_keys } from "@/db/schema";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { listKeyPostbacks } from "@/lib/partners/postbacks/config";
import { can } from "@/lib/permissions";

function parseId(v: string) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The last 50 postbacks of a key, newest first. `?failed=1` keeps only failed ones. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ keyId: string }> }) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "partner_keys.manage")) return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  const keyId = parseId((await params).keyId);
  if (keyId === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "keyId" });

  const key = await db
    .select({ id: partner_keys.id })
    .from(partner_keys)
    .where(and(eq(partner_keys.id, keyId), eq(partner_keys.org_id, orgId)))
    .limit(1);
  if (!key[0]) return apiError(404, "Partner key not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner_key" });

  const data = await listKeyPostbacks(db, {
    orgId, keyId, failedOnly: req.nextUrl.searchParams.get("failed") === "1",
  });
  return NextResponse.json({ data });
}
