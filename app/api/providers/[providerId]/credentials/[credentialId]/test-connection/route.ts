import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { loadCredentialContext } from "@/lib/providers/credential-context";
import { resolveCredentialKeyById } from "@/lib/sends/provider-credential";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// POST — uniform, NON-SENDING credential check for one stored account
// (869egmakh P2). Replaces the per-provider ad-hoc checks: the connection type's
// descriptor supplies validateCredentials, so this one route serves every
// provider and a new adapter gets a working check for free.
//
// Read-only at the provider: no SMS, no spend, no remote state change — so
// unlike the test-SEND route this is NOT gated by SEND_ENABLED. It is admin+
// (provider_credentials.manage) because it decrypts the stored key and
// transmits it to an external service, matching register-callback's bar.
// The key is resolved server-side and never returned.
//
// ⚠️ THE RESULT IS THREE-STATE and the states must not be collapsed.
// `unknown` means the provider answered in a shape we don't recognize — it is
// NOT a soft pass. Ahoi and Tells both return HTTP 200 on authentication
// failure and signal the outcome only in the body, so if either changes its
// envelope the classifier must degrade to "couldn't verify" rather than report
// a working key. Callers render it as its own state.
export async function POST(
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

  const ctx = await loadCredentialContext({ orgId, providerId, credentialId });
  if (!ctx) {
    return apiError(404, "Credential not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_credential",
    });
  }

  // No descriptor ⇒ the provider row has no adapter at all (e.g. a
  // manually-created "custom / no API" provider). Nothing to check.
  if (!ctx.descriptor) {
    return apiError(
      400,
      "This provider has no API connection type, so its credentials can't be checked.",
      API_ERROR_CODES.VALIDATION,
      { reason: "no_connection_type", provider_key: ctx.providerKey },
    );
  }

  // Descriptor exists but declares no check ⇒ the connection type genuinely
  // cannot be verified without sending (Tells: its only endpoint sends). Say so
  // explicitly. Never fabricate a pass — a check that cannot fail is worse than
  // no check, because it reads as proof.
  if (!ctx.descriptor.validateCredentials) {
    return apiError(
      400,
      `${ctx.descriptor.displayName} has no non-sending way to verify a key, so there's nothing to check without sending a message.`,
      API_ERROR_CODES.VALIDATION,
      { reason: "validation_unsupported", provider_key: ctx.providerKey },
    );
  }

  const apiKey = await resolveCredentialKeyById(db, { orgId, credentialId });
  if (apiKey === null) {
    return apiError(404, "Credential not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_credential",
    });
  }

  // validateCredentials is contractually non-throwing (network/timeout is a
  // returned `unknown`). The try/catch is a belt-and-braces guard so a future
  // adapter bug degrades to `unknown` rather than a 500 that the UI would have
  // to guess about.
  let result;
  try {
    result = await ctx.descriptor.validateCredentials({ api_key: apiKey });
  } catch {
    result = {
      state: "unknown" as const,
      detail: "The connection check failed unexpectedly.",
    };
  }

  return NextResponse.json({
    state: result.state, // "valid" | "invalid" | "unknown"
    detail: result.detail,
    // Present only on success, and only for types whose check discovers
    // something the operator needs (Text Request's dashboard ids).
    discovered: result.state === "valid" ? (result.discovered ?? null) : null,
    provider_key: ctx.providerKey,
    display_name: ctx.descriptor.displayName,
  });
}
