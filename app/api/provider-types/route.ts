import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import {
  listConnectionTypes,
  registryKeysForType,
} from "@/lib/sends/providers/registry";

// GET — the pre-built SMS connection types an operator can create a provider
// account against, sourced from the adapter registry (869egmakh P1). This is
// what replaces the free-text `sms_provider_id` box in P3: the operator picks a
// type instead of having to know that TextHub is spelled `txh`, which is how a
// provider row could previously be created that throws UnknownProviderError at
// drain time — after the campaign was already activated and scheduled.
//
// SECRET-FREE. The descriptors themselves are compile-time constants and carry
// no credential: `credentialFields` describes what to ASK for, never what is
// stored.
//
// It is NOT purely static, though — `existing_providers` is an ORG-SCOPED
// database read (added in P3). "What can I create?" genuinely depends on what
// this org already has, and that filter is a multi-tenancy invariant, not an
// optimization.
//
// Aliases are excluded from the list (see listConnectionTypes): `txh2` is a
// second TextHub ACCOUNT, not a connection type, and must not appear twice in
// the picker. But it IS counted inside `existing_providers` for TextHub, via
// registryKeysForType — otherwise "TextHub already exists" would miss it.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  // Read-only registry metadata — the same bar as viewing the providers list.
  if (!can(role, "providers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const types = listConnectionTypes();

  // Which provider rows in THIS org already exist for each connection type.
  // Alias-aware via registryKeysForType, so TextHub reports both `txh` and the
  // `txh2` second-account row — matching only the canonical code would miss
  // txh2 and offer to create a third TextHub row.
  //
  // This drives the anti-drift steer in the create UI: "TextHub already exists
  // — add an account to it instead". The picker must never silently
  // auto-suffix a new code, which is precisely how txh2 came to exist.
  const allKeys = [...new Set(types.flatMap((t) => registryKeysForType(t.key)))];
  const existingRows = allKeys.length
    ? await db
        .select({
          id: sms_providers.id,
          name: sms_providers.name,
          sms_provider_id: sms_providers.sms_provider_id,
          status: sms_providers.status,
        })
        .from(sms_providers)
        .where(
          and(
            eq(sms_providers.org_id, orgId),
            inArray(sms_providers.sms_provider_id, allKeys),
          ),
        )
        .orderBy(sms_providers.id)
    : [];

  const data = types.map((t) => {
    const keys = new Set(registryKeysForType(t.key));
    return {
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
      // Non-empty ⇒ the happy path for "I have another account of this type" is
      // ADD A CREDENTIAL to one of these, not create a second provider row.
      existing_providers: existingRows
        .filter((r) => keys.has(r.sms_provider_id))
        .map((r) => ({
          id: r.id,
          name: r.name,
          sms_provider_id: r.sms_provider_id,
          status: r.status,
        })),
    };
  });

  return NextResponse.json({ data });
}
