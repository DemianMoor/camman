import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { provider_credentials, provider_phones, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { validatePhone } from "@/lib/phone-validation";
import { resolveCredentialKeyById } from "@/lib/sends/provider-credential";
import { sendSms, toTexthubSender } from "@/lib/sends/texthub";
import { can } from "@/lib/permissions";
import { providerCredentialTestSchema } from "@/lib/validators/providers";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Send ONE test SMS using a specific stored credential, to confirm a key works
// and (the real point) that TextHub delivers URLs in `text` un-rewritten. A
// real send — so it's gated by the SEND_ENABLED master kill-switch,
// admin+ (provider_credentials.manage) — sends a real SMS, a spend action —
// and org scope. It does NOT touch stage_sends / the drain / campaigns. The
// api_key is resolved server-side and never returned.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_credentials.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  // Same master switch the drain obeys — no SMS leaves the system while off.
  if (process.env.SEND_ENABLED !== "true") {
    return apiError(
      403,
      "Sending is disabled (SEND_ENABLED is off). Turn it on to send a test.",
      API_ERROR_CODES.VALIDATION,
      { reason: "send_disabled" },
    );
  }

  const { providerId: pParam } = await params;
  const providerId = parseId(pParam);
  if (providerId === null) {
    return apiError(400, "Invalid provider id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = providerCredentialTestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }
  const { credential_id, number, text, provider_phone_id } = parsed.data;

  const phone = validatePhone(number);
  if (!phone.valid || !phone.normalized) {
    return apiError(400, phone.error ?? "Invalid phone number", API_ERROR_CODES.VALIDATION, {
      field: "number",
    });
  }

  // Ownership pre-check, scoped to the provider + org — non-secret columns
  // only. Confirms the credential exists before we bother resolving its key.
  const cred = await db
    .select({ id: provider_credentials.id })
    .from(provider_credentials)
    .innerJoin(sms_providers, eq(sms_providers.id, provider_credentials.provider_id))
    .where(
      and(
        eq(provider_credentials.id, credential_id),
        eq(provider_credentials.provider_id, providerId),
        eq(provider_credentials.org_id, orgId),
        eq(sms_providers.org_id, orgId),
      ),
    )
    .limit(1);
  if (!cred[0]) {
    return apiError(404, "Credential not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_credential",
    });
  }

  // Dual-read resolve (decrypt if encrypted, else legacy plaintext).
  const apiKey = await resolveCredentialKeyById(db, { orgId, credentialId: credential_id });
  if (apiKey === null) {
    return apiError(404, "Credential not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_credential",
    });
  }

  // Optional send-from number. Must be an ACTIVE phone on this provider/org that
  // is linked to THIS account (credential) — TextHub only accepts a `sender`
  // provisioned on the sending account. Null/omitted → no `sender` (account
  // default), preserving the prior behavior.
  let fromNumber: string | null = null;
  if (provider_phone_id != null) {
    const ph = await db
      .select({ phone_number: provider_phones.phone_number })
      .from(provider_phones)
      .where(
        and(
          eq(provider_phones.id, provider_phone_id),
          eq(provider_phones.provider_id, providerId),
          eq(provider_phones.org_id, orgId),
          eq(provider_phones.credential_id, credential_id),
          eq(provider_phones.status, "active"),
        ),
      )
      .limit(1);
    if (!ph[0]) {
      return apiError(
        400,
        "That send-from number isn't an active number linked to this account",
        API_ERROR_CODES.VALIDATION,
        { field: "provider_phone_id" },
      );
    }
    fromNumber = ph[0].phone_number;
  }

  // Single recipient; link rides in `text`; never long_url / group. `sender` is
  // the send-from number as national digits (omitted when none was chosen).
  const result = await sendSms({
    apiKey,
    text,
    number: phone.normalized,
    sender: fromNumber ? toTexthubSender(fromNumber) : undefined,
  });

  // Echo what was sent (NOT the api_key) so the operator can eyeball the exact
  // text + compare the URL that arrives on the phone. `from` is the E.164
  // send-from number (null when the account default was used).
  return NextResponse.json({
    ok: result.ok,
    to: phone.normalized,
    from: fromNumber,
    sentText: text,
    messageId: result.messageId,
    response: result.response,
    error: result.error,
    status: result.status,
  });
}
