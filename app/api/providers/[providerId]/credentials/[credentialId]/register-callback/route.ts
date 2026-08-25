import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { provider_credentials } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { appOrigin } from "@/lib/app-origin";
import { can } from "@/lib/permissions";
import { loadCredentialContext } from "@/lib/providers/credential-context";
import { resolveCredentialKeyById } from "@/lib/sends/provider-credential";
import { registerOptOutCallback } from "@/lib/sends/texthub-optout";
import { registerOptOutCallbackSchema } from "@/lib/validators/providers";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// The callback origin comes from NEXT_PUBLIC_SITE_URL and NOTHING ELSE.
//
// ⚠️ This deliberately does NOT read the request host. It used to prefer it, on
// the reasoning that an admin clicking Register is on a reachable origin — but
// the URL registered here is persisted by the PROVIDER and long outlives the
// request. Registering from a preview deployment pinned STOP delivery to a URL
// that later disappears, and now that CamMan answers on a partner-facing
// hostname too, it would silently move opt-out traffic off the primary host.
// Both failures are invisible until STOPs stop arriving. Fail loudly instead.

// POST — register this credential's inbound opt-out (STOP) callback with
// TextHub. Admin+ (provider_credentials.manage) — resolves and transmits the
// plaintext key to TextHub. Mints a stable per-credential token on first call
// (reused thereafter, so the callback URL never changes), then asks TextHub to
// deliver STOPs to /api/webhooks/texthub/opt-out/<token>. Returns TextHub's RAW
// response so the operator can confirm it was accepted — the api_key is
// resolved server-side and never returned.
export async function POST(
  req: NextRequest,
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

  // Optional body (keywords). Tolerate an empty body.
  let body: unknown = {};
  try {
    const text = await req.text();
    if (text.trim().length > 0) body = JSON.parse(text);
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = registerOptOutCallbackSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const origin = appOrigin();
  if (!origin) {
    return apiError(
      500,
      "Server misconfiguration: NEXT_PUBLIC_SITE_URL is not set, so the opt-out callback URL cannot be built. Set it to the primary production origin and redeploy — registration will not fall back to the request host.",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Resolve the credential, org- and provider-scoped (ownership check).
  // Non-secret columns only — the key is resolved separately below.
  const ctx = await loadCredentialContext({ orgId, providerId, credentialId });
  if (!ctx) {
    return apiError(404, "Credential not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_credential",
    });
  }

  // CONNECTION-TYPE GATE (869egmakh P2). This route registers a TEXTHUB opt-out
  // callback and builds a /api/webhooks/texthub/opt-out/<token> URL, so it is
  // only correct for the TextHub connection type. The restriction previously
  // existed ONLY in the client component; the route itself had no reference to
  // sms_provider_id at all, so a direct POST with any provider's credential
  // would have shipped that key to TextHub AND minted an inbound_webhook_token
  // on a credential whose provider never uses that webhook path.
  if (!ctx.descriptor?.supportsOptOutCallbackRegistration) {
    return apiError(
      400,
      `STOP-callback registration isn't available for ${ctx.descriptor?.displayName ?? ctx.providerName}.`,
      API_ERROR_CODES.VALIDATION,
      { reason: "optout_callback_unsupported", provider_key: ctx.providerKey },
    );
  }

  // Re-read the token column for the row we just authorized.
  const cred = await db
    .select({
      id: provider_credentials.id,
      inbound_webhook_token: provider_credentials.inbound_webhook_token,
    })
    .from(provider_credentials)
    .where(eq(provider_credentials.id, ctx.credentialId))
    .limit(1);
  if (!cred[0]) {
    return apiError(404, "Credential not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_credential",
    });
  }

  // Dual-read resolve (decrypt if encrypted, else legacy plaintext).
  const apiKey = await resolveCredentialKeyById(db, { orgId, credentialId });
  if (apiKey === null) {
    return apiError(404, "Credential not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_credential",
    });
  }

  // Mint a stable token on first registration; reuse it afterwards so the
  // callback URL (and any already-registered value at TextHub) stays put.
  let token = cred[0].inbound_webhook_token;
  if (!token) {
    token = randomBytes(32).toString("hex");
    await db
      .update(provider_credentials)
      .set({ inbound_webhook_token: token, updated_at: new Date() })
      .where(eq(provider_credentials.id, cred[0].id));
  }

  const callbackUrl = `${origin}/api/webhooks/texthub/opt-out/${token}`;

  // Defensive: never hand TextHub a malformed callback. Must be an absolute
  // http(s) URL (a mistyped origin could otherwise slip through).
  let parsedCallback: URL;
  try {
    parsedCallback = new URL(callbackUrl);
  } catch {
    return apiError(
      500,
      `Resolved an invalid callback URL: ${callbackUrl}`,
      API_ERROR_CODES.VALIDATION,
    );
  }
  if (parsedCallback.protocol !== "https:" && parsedCallback.protocol !== "http:") {
    return apiError(
      500,
      `Callback URL must be http(s): ${callbackUrl}`,
      API_ERROR_CODES.VALIDATION,
    );
  }

  const result = await registerOptOutCallback({
    apiKey,
    callbackUrl,
    keywords: parsed.data.keywords,
  });

  // Echo the callback URL + TextHub's raw response (NOT the api_key).
  return NextResponse.json({
    ok: result.ok,
    callbackUrl,
    status: result.status,
    response: result.rawBody,
    error: result.error,
  });
}
