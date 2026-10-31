import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { deliveryEnabled, sendTestPostback } from "@/lib/partners/postbacks/deliver";
import { can } from "@/lib/permissions";

export const maxDuration = 30;

function parseId(v: string) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Fire one sample postback with the key's saved template. The body is ignored. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ keyId: string }> }) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "partner_keys.manage")) return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  const keyId = parseId((await params).keyId);
  if (keyId === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "keyId" });

  if (!deliveryEnabled()) return apiError(409, "Postback delivery is switched off", API_ERROR_CODES.CONFLICT);
  try {
    const out = await sendTestPostback(db, { orgId, keyId });
    if ("too_soon" in out) {
      return apiError(429, "Wait a few seconds between test sends", API_ERROR_CODES.RATE_LIMITED);
    }
    return NextResponse.json(out);
  } catch (err) {
    const m = err instanceof Error ? err.message : "";
    if (m === "key_not_found") {
      return apiError(404, "Partner key not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner_key" });
    }
    if (m === "no_template") {
      return apiError(400, "Save a postback URL template first", API_ERROR_CODES.VALIDATION, { field: "postback_url_template" });
    }
    throw err;
  }
}
