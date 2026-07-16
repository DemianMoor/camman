import { and, eq, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, provider_credentials, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { encryptSecret } from "@/lib/crypto/secret-box";
import { countNumberlessSendEligibleStages } from "@/lib/providers/second-account-guard";
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

  // Manager+ (provider_credentials.view) — read-only access to the masked list.
  if (!can(role, "provider_credentials.view")) {
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
    )
    // Stable creation order — labels aren't unique, so without this the list
    // renders in whatever order the planner returns.
    .orderBy(provider_credentials.id);

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

// POST — create a new credential (account) for a provider. Multi-account
// (Phase 3): always INSERTs a new row; never upserts or rotates. Rotation of
// an existing account goes through PATCH .../credentials/[credentialId]. The
// key is never logged and never echoed back (response is masked).
//
// Guardrail: adding a 2nd+ account is blocked (409) while the provider has
// any send-eligible stage with no provider_phone_id — such a stage resolves
// its key via the single-credential legacy fallback, which is ambiguous once
// a 2nd account exists. See lib/providers/second-account-guard.ts.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  // Admin+ (provider_credentials.manage) — creating an account is a
  // secret-holding action, a stricter bar than viewing the masked list.
  if (!can(role, "provider_credentials.manage")) {
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

  // Encrypt once outside the transaction — the plaintext never touches the
  // DB; only the encrypted blob + last4 (for display) are written.
  const { last4, masked } = maskApiKey(api_key);
  const enc = encryptSecret(api_key);

  let blockedCount: number | null = null;
  let insertedId: number | null = null;

  await db.transaction(async (tx) => {
    // Best-effort: the existing-credential count and the insert share this
    // transaction so a single request's decision is internally consistent,
    // but Postgres READ COMMITTED means two concurrent POSTs can still both
    // read count=0 and both insert — this narrows the race, it doesn't close
    // it. Acceptable for an operator-driven, low-frequency action.
    const existingRows = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM provider_credentials
      WHERE provider_id = ${providerId} AND org_id = ${orgId}
    `)) as unknown as { n: number }[];
    const existingCount = existingRows[0]?.n ?? 0;

    if (existingCount >= 1) {
      const n = await countNumberlessSendEligibleStages(tx, { orgId, providerId });
      if (n > 0) {
        blockedCount = n;
        return;
      }
    }

    const inserted = await tx
      .insert(provider_credentials)
      .values({
        org_id: orgId,
        provider_id: providerId,
        brand_id: brand_id ?? null,
        api_key_encrypted: enc,
        api_key_last4: last4,
        label,
      })
      .returning({ id: provider_credentials.id });
    insertedId = inserted[0].id;
  });

  if (blockedCount !== null) {
    return apiError(
      409,
      "Assign numbers to all existing stages for this provider before adding a second account",
      API_ERROR_CODES.CONFLICT,
      { reason: "numberless_stages_block_multi_account", count: blockedCount },
    );
  }

  // `id` lets the UI immediately address the new account (e.g. a follow-up
  // PATCH { phone_ids }) — labels are NOT unique, so id is the only safe key.
  return NextResponse.json({ ok: true, id: insertedId, brand_id, masked, last4 });
}
