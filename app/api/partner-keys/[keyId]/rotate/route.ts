import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { partner_keys } from "@/db/schema";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { clearAlert } from "@/lib/alerts/alert-state";
import { generateSecret, hashSecret } from "@/lib/intake/partner-key";
import { can } from "@/lib/permissions";

function parseId(v: string) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Mint a new secret for an existing key. Returns the plaintext ONCE.
 *
 * ⚠️ ROTATION IS IMMEDIATE AND BREAKING — there is no dual-accept window. The
 * partner's next request with the old secret gets 401 and their leads stop
 * until they deploy the new one. That is the correct default for a credential
 * you are rotating because it may have leaked; a grace period would keep a
 * compromised secret working for exactly as long as it is most dangerous. The
 * UI says so before the operator confirms.
 *
 * ⚠️ The token is NOT rotated. It is addressing, not authentication, so
 * changing it would force the partner to update a URL for no security gain.
 * If a token itself must change, create a new key.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ keyId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "partner_keys.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const { keyId: raw } = await params;
  const keyId = parseId(raw);
  if (keyId === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "keyId" });

  const secret = generateSecret();
  const updated = await db
    .update(partner_keys)
    .set({
      secret_hash: hashSecret(secret),
      secret_last4: secret.slice(-4),
      rotated_at: new Date(),
    })
    .where(and(eq(partner_keys.id, keyId), eq(partner_keys.org_id, orgId)))
    .returning();

  if (!updated[0]) {
    return apiError(404, "Partner key not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner_key" });
  }

  // Clear any standing auth-failure alert. Without this the alert stays 'firing'
  // and the NEXT genuine incident on this key would be silent — the failure mode
  // of every state-gated alert that nobody resets. Rotation is exactly the
  // remediation the alert asks for, so it is the right place to reset.
  void clearAlert(db, { alertKey: `intake:auth_fail:${keyId}`, orgId });

  return NextResponse.json({
    id: updated[0].id,
    partner_slug: updated[0].partner_slug,
    rotated_at: updated[0].rotated_at,
    // Shown once. Only its hash is stored.
    secret,
  });
}
