import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { getDescriptor } from "@/lib/sends/providers/registry";

// POST — validate credential values that are NOT stored yet (869egmakh P3).
//
// The sibling route …/credentials/[credentialId]/test-connection checks a key
// already in the database. At provider-CREATE time no such row exists, so this
// takes the values straight from the form and runs the same descriptor check
// against them. That is the whole difference; the classification, the three
// states and the honesty rules are identical.
//
// Admin+ (provider_credentials.manage): the caller is handing us a live
// credential to transmit to an external service, the same bar as creating one.
// Read-only at the provider — no SMS, no spend, no remote state change — so it
// is NOT gated by SEND_ENABLED.
//
// The submitted key is used for this request and nothing else: never logged,
// never persisted, never echoed back.
const validateSchema = z.object({
  fields: z.record(z.string(), z.string()).default({}),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { role } = auth;

  if (!can(role, "provider_credentials.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { key } = await params;
  const descriptor = getDescriptor(key);
  if (!descriptor) {
    return apiError(404, "Unknown connection type", API_ERROR_CODES.NOT_FOUND, {
      entity: "connection_type",
    });
  }
  if (!descriptor.validateCredentials) {
    return apiError(
      400,
      `${descriptor.displayName} has no non-sending way to verify a key, so there's nothing to check without sending a message.`,
      API_ERROR_CODES.VALIDATION,
      { reason: "validation_unsupported", provider_key: key },
    );
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = validateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }

  // Contractually non-throwing; the guard keeps an adapter bug degrading to
  // `unknown` rather than a 500 the UI would have to interpret.
  let result;
  try {
    result = await descriptor.validateCredentials(parsed.data.fields);
  } catch {
    result = { state: "unknown" as const, detail: "The connection check failed unexpectedly." };
  }

  return NextResponse.json({
    state: result.state,
    detail: result.detail,
    discovered: result.state === "valid" ? (result.discovered ?? null) : null,
    provider_key: key,
    display_name: descriptor.displayName,
  });
}
