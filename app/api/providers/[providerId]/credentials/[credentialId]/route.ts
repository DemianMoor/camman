import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, provider_credentials, provider_phones } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { encryptSecret } from "@/lib/crypto/secret-box";
import { applyCredentialPhoneLinks } from "@/lib/providers/credential-phone-links";
import { can } from "@/lib/permissions";
import { maskApiKey } from "@/lib/sends/provider-credential";
import { providerCredentialUpdateSchema } from "@/lib/validators/providers";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// PATCH — edit an existing credential (account): label, brand scoping,
// linked numbers, and/or rotate the key. Admin+ (provider_credentials.manage)
// — every field this endpoint touches is secret-adjacent (the key itself, or
// which numbers/brand a key is scoped to). The plaintext key is never echoed
// back; the response is always masked.
export async function PATCH(
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

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = providerCredentialUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }
  const { label, brand_id, api_key, phone_ids } = parsed.data;

  // Verify the credential exists, scoped to (id, provider, org). Non-secret
  // columns only — current label/brand are reused below to build the
  // response for fields the caller didn't touch.
  const existing = await db
    .select({
      id: provider_credentials.id,
      label: provider_credentials.label,
      brand_id: provider_credentials.brand_id,
      api_key_last4: provider_credentials.api_key_last4,
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
  if (!existing[0]) {
    return apiError(404, "Credential not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_credential",
    });
  }

  // brand_id: a positive number must belong to this org; null explicitly
  // clears it; undefined leaves it untouched.
  if (brand_id != null) {
    const b = await db
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.id, brand_id), eq(brands.org_id, orgId)))
      .limit(1);
    if (!b[0]) {
      return apiError(400, "brand_id doesn't belong to your organization", API_ERROR_CODES.VALIDATION, {
        field: "brand_id",
      });
    }
  }

  // phone_ids: every id must be a provider_phones row in this org+provider.
  // A phone already linked to a different credential may be re-linked here
  // (an explicit move) — ownership only checks org+provider, not credential.
  // Deduped up front: the SELECT returns DISTINCT rows, so comparing against
  // the raw length would false-positive on a payload like [5,5].
  const uniquePhoneIds = phone_ids !== undefined ? [...new Set(phone_ids)] : undefined;
  if (uniquePhoneIds !== undefined && uniquePhoneIds.length > 0) {
    const rows = await db
      .select({ id: provider_phones.id })
      .from(provider_phones)
      .where(
        and(
          inArray(provider_phones.id, uniquePhoneIds),
          eq(provider_phones.org_id, orgId),
          eq(provider_phones.provider_id, providerId),
        ),
      );
    if (rows.length !== uniquePhoneIds.length) {
      const found = new Set(rows.map((r) => r.id));
      const invalidIds = uniquePhoneIds.filter((id) => !found.has(id));
      return apiError(
        400,
        `${invalidIds.length} phone id(s) do not belong to this provider: ${invalidIds.join(", ")}`,
        API_ERROR_CODES.VALIDATION,
        { field: "phone_ids", invalid_ids: invalidIds },
      );
    }
  }

  // Rotation: re-encrypt outside the transaction (pure CPU, no I/O) — the
  // plaintext never touches the DB, only the encrypted blob + last4.
  let rotatedLast4: string | null = null;
  let rotatedEnc: string | null = null;
  if (api_key !== undefined) {
    rotatedLast4 = maskApiKey(api_key).last4;
    rotatedEnc = encryptSecret(api_key);
  }

  await db.transaction(async (tx) => {
    const updates: Partial<typeof provider_credentials.$inferInsert> = {};
    if (label !== undefined) updates.label = label;
    if (brand_id !== undefined) updates.brand_id = brand_id;
    if (api_key !== undefined) {
      updates.api_key_encrypted = rotatedEnc;
      updates.api_key_last4 = rotatedLast4;
      updates.api_key = null;
    }
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date();
      await tx
        .update(provider_credentials)
        .set(updates)
        .where(eq(provider_credentials.id, credentialId));
    }

    if (uniquePhoneIds !== undefined) {
      await applyCredentialPhoneLinks(tx, {
        orgId,
        credentialId,
        phoneIds: uniquePhoneIds,
      });
    }
  });

  const finalLabel = label !== undefined ? label : existing[0].label;
  const finalBrandId = brand_id !== undefined ? brand_id : existing[0].brand_id;
  const finalLast4 = api_key !== undefined ? rotatedLast4 : existing[0].api_key_last4;

  const linkedCount = await db
    .select({ id: provider_phones.id })
    .from(provider_phones)
    .where(
      and(
        eq(provider_phones.credential_id, credentialId),
        eq(provider_phones.org_id, orgId),
      ),
    );

  return NextResponse.json({
    ok: true,
    id: credentialId,
    label: finalLabel,
    brand_id: finalBrandId,
    last4: finalLast4 ?? "",
    masked: `••••${finalLast4 ?? ""}`,
    linked_numbers: linkedCount.length,
  });
}

// DELETE — remove a stored key. Admin+ (provider_credentials.manage). Org-scoped
// + tied to the provider in the path so one org can't delete another's credential.
export async function DELETE(
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

  const deleted = await db
    .delete(provider_credentials)
    .where(
      and(
        eq(provider_credentials.id, credentialId),
        eq(provider_credentials.provider_id, providerId),
        eq(provider_credentials.org_id, orgId),
      ),
    )
    .returning({ id: provider_credentials.id });

  if (!deleted[0]) {
    return apiError(404, "Credential not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_credential",
    });
  }
  return NextResponse.json({ ok: true });
}
