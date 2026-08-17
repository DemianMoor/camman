import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { sms_providers } from "@/db/schema";
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
// SECRET-FREE. The descriptors themselves are compile-time constants and carry
// no credential: `credentialFields` describes what to ASK for, never what is
// stored.
//
// It is NOT purely static, though — `existing_providers` is an ORG-SCOPED
// database read (added in P3). "What can I create?" genuinely depends on what
// this org already has, and that filter is a multi-tenancy invariant, not an
// optimization.
//
// One entry per connection TYPE. A second account of an existing type (the
// `txh2` row) is not a type and must not appear twice in the picker — but it IS
// counted inside `existing_providers` for TextHub, because that grouping keys on
// adapter_code, which every row of a type shares regardless of its identity code.
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
  //
  // Grouped by adapter_code — the column that IS the connection type. This used
  // to enumerate registry keys to catch the `txh2` alias next to `txh`; with the
  // alias retired that enumeration would return only ['txh'] and would miss the
  // txh2 row entirely, under-reporting what already exists. adapter_code matches
  // every row of a type whatever identity code it carries, including rows
  // created long after this code was written.
  //
  // This drives the anti-drift steer in the create UI: "TextHub already exists
  // — add an account to it instead". The picker must never silently
  // auto-suffix a new code, which is precisely how txh2 came to exist.
  const typeCodes = types.map((t) => t.key);
  const existingRows = typeCodes.length
    ? await db
        .select({
          id: sms_providers.id,
          name: sms_providers.name,
          sms_provider_id: sms_providers.sms_provider_id,
          adapter_code: sms_providers.adapter_code,
          status: sms_providers.status,
        })
        .from(sms_providers)
        .where(
          and(
            eq(sms_providers.org_id, orgId),
            inArray(sms_providers.adapter_code, typeCodes),
          ),
        )
        .orderBy(sms_providers.id)
    : [];

  const data = types.map((t) => {
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
      // Operator-facing "About this provider" copy (R3). Code-owned constants,
      // so this stays a static read with no DB round trip and no secrets — the
      // notes describe how a connection TYPE behaves, never what is stored.
      // Always an array (never null) so the client renders a list or nothing,
      // with no undefined-check at the call site.
      notes: t.descriptor.notes ?? [],
      // false ⇒ no non-sending way to prove a key for this type. The UI must say
      // so, NOT render a Test button that cannot fail (Tells today).
      can_validate: t.canValidate,
      // Non-empty ⇒ the happy path for "I have another account of this type" is
      // ADD A CREDENTIAL to one of these, not create a second provider row.
      existing_providers: existingRows
        .filter((r) => r.adapter_code === t.key)
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
