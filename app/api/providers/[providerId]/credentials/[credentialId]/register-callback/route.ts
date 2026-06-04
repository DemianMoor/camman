import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { provider_credentials } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { registerOptOutCallback } from "@/lib/sends/texthub-optout";
import { registerOptOutCallbackSchema } from "@/lib/validators/providers";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// POST — register this credential's inbound opt-out (STOP) callback with
// TextHub (manager+). Mints a stable per-credential token on first call (reused
// thereafter, so the callback URL never changes), then asks TextHub to deliver
// STOPs to /api/webhooks/texthub/opt-out/<token>. Returns TextHub's RAW
// response so the operator can confirm it was accepted — the api_key is
// resolved server-side and never returned.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string; credentialId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "providers.update")) {
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

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!siteUrl) {
    return apiError(
      500,
      "Server misconfiguration: NEXT_PUBLIC_SITE_URL is not set",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Resolve the credential, org- and provider-scoped (ownership check).
  const cred = await db
    .select({
      id: provider_credentials.id,
      api_key: provider_credentials.api_key,
      inbound_webhook_token: provider_credentials.inbound_webhook_token,
    })
    .from(provider_credentials)
    .where(
      and(
        eq(provider_credentials.id, credentialId),
        eq(provider_credentials.provider_id, providerId),
        eq(provider_credentials.org_id, orgId),
      ),
    )
    .limit(1);
  if (!cred[0]) {
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

  const base = siteUrl.replace(/\/+$/, "");
  const callbackUrl = `${base}/api/webhooks/texthub/opt-out/${token}`;

  const result = await registerOptOutCallback({
    apiKey: cred[0].api_key,
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
