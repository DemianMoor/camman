import { and, eq, isNull, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, provider_credentials, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { encryptSecret } from "@/lib/crypto/secret-box";
import { maskApiKey } from "@/lib/sends/provider-credential";
import { can } from "@/lib/permissions";
import { providerCredentialSetSchema } from "@/lib/validators/providers";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Confirm the provider belongs to the caller's org. Returns true/false.
async function providerInOrg(providerId: number, orgId: string) {
  const rows = await db
    .select({ id: sms_providers.id })
    .from(sms_providers)
    .where(and(eq(sms_providers.id, providerId), eq(sms_providers.org_id, orgId)))
    .limit(1);
  return rows.length > 0;
}

// GET — list a provider's keys, MASKED. Never returns api_key in plaintext.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  // Manager+ only — this surface manages secrets, even though it shows them masked.
  if (!can(role, "providers.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId: pParam } = await params;
  const providerId = parseId(pParam);
  if (providerId === null) {
    return apiError(400, "Invalid provider id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }
  if (!(await providerInOrg(providerId, orgId))) {
    return apiError(404, "Provider not found", API_ERROR_CODES.NOT_FOUND, { entity: "provider" });
  }

  const rows = await db
    .select({
      id: provider_credentials.id,
      brand_id: provider_credentials.brand_id,
      brand_name: brands.name,
      label: provider_credentials.label,
      api_key_last4: provider_credentials.api_key_last4,
      // Only used as a pre-backfill fallback to derive last4 below — never
      // returned to the client.
      api_key: provider_credentials.api_key,
      updated_at: provider_credentials.updated_at,
      linked_numbers: sql<number>`(SELECT count(*)::int FROM provider_phones ph WHERE ph.credential_id = ${provider_credentials.id})`,
    })
    .from(provider_credentials)
    .leftJoin(brands, eq(brands.id, provider_credentials.brand_id))
    .where(
      and(
        eq(provider_credentials.provider_id, providerId),
        eq(provider_credentials.org_id, orgId),
      ),
    );

  // Mask before serializing — the plaintext api_key never leaves the server,
  // and it is never decrypted here (api_key_last4 is populated at write time;
  // the plaintext api_key column is only a pre-backfill fallback).
  const data = rows.map((r) => {
    let last4 = "";
    let masked = "";
    if (r.api_key_last4) {
      last4 = r.api_key_last4;
      masked = `••••${last4}`;
    } else if (r.api_key) {
      ({ last4, masked } = maskApiKey(r.api_key));
    }
    return {
      id: r.id,
      brand_id: r.brand_id,
      brand_name: r.brand_name,
      label: r.label,
      linked_numbers: r.linked_numbers,
      last4,
      masked,
      updated_at: r.updated_at,
    };
  });

  return NextResponse.json({ data });
}

// POST — set or rotate a key for (provider, brand|default). Upsert; the key is
// never logged and never echoed back (response is masked).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "providers.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId: pParam } = await params;
  const providerId = parseId(pParam);
  if (providerId === null) {
    return apiError(400, "Invalid provider id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }
  if (!(await providerInOrg(providerId, orgId))) {
    return apiError(404, "Provider not found", API_ERROR_CODES.NOT_FOUND, { entity: "provider" });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = providerCredentialSetSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }
  const { brand_id, api_key, label } = parsed.data;

  // Derived default label: the owning brand's name, or "Default" for the
  // provider-wide key. Never overwrites an existing label on rotate (see the
  // COALESCE below) — only used for brand-new rows / rows with no label yet.
  let derivedLabel = "Default";
  if (brand_id != null) {
    const b = await db
      .select({ id: brands.id, name: brands.name })
      .from(brands)
      .where(and(eq(brands.id, brand_id), eq(brands.org_id, orgId)))
      .limit(1);
    if (!b[0]) {
      return apiError(400, "brand_id doesn't belong to your organization", API_ERROR_CODES.VALIDATION, {
        field: "brand_id",
      });
    }
    derivedLabel = b[0].name;
  }

  // Encrypt once outside the transaction — the plaintext never touches the
  // DB; only the encrypted blob + last4 (for display) are written.
  const { last4, masked } = maskApiKey(api_key);
  const enc = encryptSecret(api_key);

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: provider_credentials.id })
      .from(provider_credentials)
      .where(
        and(
          eq(provider_credentials.provider_id, providerId),
          eq(provider_credentials.org_id, orgId),
          brand_id == null
            ? isNull(provider_credentials.brand_id)
            : eq(provider_credentials.brand_id, brand_id),
        ),
      )
      .limit(1);

    if (existing[0]) {
      // Rotate: replace the secret, clear the legacy plaintext column, and
      // only set a label if one isn't already there.
      await tx
        .update(provider_credentials)
        .set({
          api_key_encrypted: enc,
          api_key_last4: last4,
          api_key: null,
          label: sql`COALESCE(${provider_credentials.label}, ${label ?? derivedLabel})`,
          updated_at: new Date(),
        })
        .where(eq(provider_credentials.id, existing[0].id));
    } else {
      await tx.insert(provider_credentials).values({
        org_id: orgId,
        provider_id: providerId,
        brand_id: brand_id ?? null,
        api_key_encrypted: enc,
        api_key_last4: last4,
        label: label ?? derivedLabel,
      });
    }
  });

  return NextResponse.json({ ok: true, brand_id, masked, last4 });
}
