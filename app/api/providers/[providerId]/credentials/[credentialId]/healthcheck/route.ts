import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { provider_credentials, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { resolveCredentialKeyById } from "@/lib/sends/provider-credential";
import { simpletextingHealthcheck } from "@/lib/sends/providers/simpletexting";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// GET — non-sending SimpleTexting connection check for a stored credential.
// Resolves the account's token server-side and calls SimpleTexting's
// GET /api/phones to confirm the token authenticates and to surface the usable
// sender numbers. Read-only: NO SMS is sent, no spend — so it is NOT gated by
// SEND_ENABLED (unlike the test-send route). Admin+ (provider_credentials.manage)
// because it resolves and transmits the plaintext key to an external service,
// matching the register-callback route's bar. The token is never returned.
//
// SimpleTexting-only: the other providers authenticate differently and have no
// equivalent phones endpoint, so a non-smpl credential is rejected rather than
// misrouted (a txh key sent to SimpleTexting would just fail auth).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ providerId: string; credentialId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_credentials.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId: pParam, credentialId: cParam } = await params;
  const providerId = parseId(pParam);
  const credentialId = parseId(cParam);
  if (providerId === null || credentialId === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  // Ownership + provider-key check in one query, org- and provider-scoped.
  // Non-secret columns only — the key is resolved separately below.
  const row = await db
    .select({
      credId: provider_credentials.id,
      providerKey: sms_providers.sms_provider_id,
    })
    .from(provider_credentials)
    .innerJoin(sms_providers, eq(sms_providers.id, provider_credentials.provider_id))
    .where(
      and(
        eq(provider_credentials.id, credentialId),
        eq(provider_credentials.provider_id, providerId),
        eq(provider_credentials.org_id, orgId),
        eq(sms_providers.org_id, orgId),
      ),
    )
    .limit(1);
  if (!row[0]) {
    return apiError(404, "Credential not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_credential",
    });
  }
  if (row[0].providerKey !== "smpl") {
    return apiError(
      400,
      "Connection check is only available for SimpleTexting accounts",
      API_ERROR_CODES.VALIDATION,
      { reason: "provider_not_simpletexting" },
    );
  }

  // Dual-read resolve (decrypt if encrypted, else legacy plaintext).
  const apiKey = await resolveCredentialKeyById(db, { orgId, credentialId });
  if (apiKey === null) {
    return apiError(404, "Credential not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_credential",
    });
  }

  const result = await simpletextingHealthcheck(apiKey);

  return NextResponse.json({
    ok: result.ok,
    status: result.status,
    numbers: result.numbers,
    error: result.error,
  });
}
