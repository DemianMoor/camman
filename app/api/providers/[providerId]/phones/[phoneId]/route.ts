import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, provider_phones } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { providerPhoneUpdateSchema } from "@/lib/validators/provider-phones";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ providerId: string; phoneId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_phones.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId, phoneId } = await params;
  const pid = parseId(providerId);
  const phid = parseId(phoneId);
  if (pid === null || phid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const rows = await db
    .select({
      id: provider_phones.id,
      org_id: provider_phones.org_id,
      provider_id: provider_phones.provider_id,
      brand_id: provider_phones.brand_id,
      phone_number: provider_phones.phone_number,
      country_code: provider_phones.country_code,
      dial_code: provider_phones.dial_code,
      local_number: provider_phones.local_number,
      cost_per_sms: provider_phones.cost_per_sms,
      status: provider_phones.status,
      archived_at: provider_phones.archived_at,
      created_at: provider_phones.created_at,
      brand: {
        id: brands.id,
        name: brands.name,
        color: brands.color,
        avatar_url: brands.avatar_url,
      },
    })
    .from(provider_phones)
    .leftJoin(brands, eq(provider_phones.brand_id, brands.id))
    .where(
      and(
        eq(provider_phones.id, phid),
        eq(provider_phones.provider_id, pid),
        eq(provider_phones.org_id, orgId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return apiError(404, "Phone not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_phone",
    });
  }
  return NextResponse.json({
    ...row,
    brand: row.brand && row.brand.id !== null ? row.brand : null,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string; phoneId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_phones.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId, phoneId } = await params;
  const pid = parseId(providerId);
  const phid = parseId(phoneId);
  if (pid === null || phid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  // Explicitly reject phone_number changes — the column is intentionally
  // immutable post-creation. Status changes go through /status, not PATCH.
  if (
    typeof json === "object" &&
    json !== null &&
    ("phone_number" in json || "status" in json)
  ) {
    return apiError(
      400,
      "phone_number and status cannot be changed via PATCH",
      API_ERROR_CODES.VALIDATION,
      { field: "phone_number" in (json as object) ? "phone_number" : "status" },
    );
  }

  const parsed = providerPhoneUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    if (k === "brand_id") {
      updates[k] = v ?? null;
    } else if (k === "cost_per_sms") {
      updates[k] = String(v);
    } else {
      updates[k] = v;
    }
  }

  const updated = await db
    .update(provider_phones)
    .set(updates)
    .where(
      and(
        eq(provider_phones.id, phid),
        eq(provider_phones.provider_id, pid),
        eq(provider_phones.org_id, orgId),
      ),
    )
    .returning();

  if (!updated[0]) {
    return apiError(404, "Phone not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_phone",
    });
  }
  return NextResponse.json(updated[0]);
}
