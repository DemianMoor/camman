import { NextResponse } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { listConnectionTypes } from "@/lib/sends/providers/registry";

// GET — the pre-built SMS connection types an operator can create a provider
// account against, sourced from the adapter registry (869egmakh P1). This is
// what replaces the free-text `sms_provider_id` box in P3: the operator picks a
// type instead of having to know that TextHub is spelled `txh`, which is how a
// provider row could previously be created that throws UnknownProviderError at
// drain time — after the campaign was already activated and scheduled.
//
// STATIC + SECRET-FREE. Descriptors are compile-time constants: no database
// read, no credential, no per-org data. `credentialFields` describes what to
// ASK for, never what is stored. Nothing here is org-scoped, so there is no
// org_id filter to apply — but membership is still required, because the set of
// integrations we support isn't public.
//
// Aliases are excluded (see listConnectionTypes): `txh2` is a second TextHub
// ACCOUNT, not a connection type, and must not appear twice in the picker.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { role } = auth;

  // Read-only registry metadata — the same bar as viewing the providers list.
  if (!can(role, "providers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const data = listConnectionTypes().map((t) => ({
    key: t.key,
    display_name: t.descriptor.displayName,
    blurb: t.descriptor.blurb,
    credential_fields: t.descriptor.credentialFields.map((f) => ({
      name: f.name,
      label: f.label,
      placeholder: f.placeholder ?? null,
      help: f.help ?? null,
      secret: f.secret ?? false,
    })),
    // false ⇒ no non-sending way to prove a key for this type. The UI must say
    // so, NOT render a Test button that cannot fail (Tells today).
    can_validate: t.canValidate,
  }));

  return NextResponse.json({ data });
}
