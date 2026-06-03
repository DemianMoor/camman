import { and, eq, isNull } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, provider_credentials, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
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
      api_key: provider_credentials.api_key,
      updated_at: provider_credentials.updated_at,
    })
    .from(provider_credentials)
    .leftJoin(brands, eq(brands.id, provider_credentials.brand_id))
    .where(
      and(
        eq(provider_credentials.provider_id, providerId),
        eq(provider_credentials.org_id, orgId),
      ),
    );

  // Mask before serializing — the plaintext api_key never leaves the server.
  const data = rows.map((r) => ({
    id: r.id,
    brand_id: r.brand_id,
    brand_name: r.brand_name,
    last4: maskApiKey(r.api_key).last4,
    masked: maskApiKey(r.api_key).masked,
    updated_at: r.updated_at,
  }));

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
  const { brand_id, api_key } = parsed.data;

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

  const masked = await db.transaction(async (tx) => {
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
      await tx
        .update(provider_credentials)
        .set({ api_key, updated_at: new Date() })
        .where(eq(provider_credentials.id, existing[0].id));
    } else {
      await tx.insert(provider_credentials).values({
        org_id: orgId,
        provider_id: providerId,
        brand_id: brand_id ?? null,
        api_key,
      });
    }
    return maskApiKey(api_key);
  });

  return NextResponse.json({ ok: true, brand_id, masked: masked.masked, last4: masked.last4 });
}
