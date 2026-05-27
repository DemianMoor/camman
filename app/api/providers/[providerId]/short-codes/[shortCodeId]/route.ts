import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, provider_short_codes } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { providerShortCodeUpdateSchema } from "@/lib/validators/provider-short-codes";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ providerId: string; shortCodeId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_short_codes.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId, shortCodeId } = await params;
  const pid = parseId(providerId);
  const scid = parseId(shortCodeId);
  if (pid === null || scid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const rows = await db
    .select({
      id: provider_short_codes.id,
      org_id: provider_short_codes.org_id,
      provider_id: provider_short_codes.provider_id,
      brand_id: provider_short_codes.brand_id,
      short_code: provider_short_codes.short_code,
      cost_per_sms: provider_short_codes.cost_per_sms,
      status: provider_short_codes.status,
      archived_at: provider_short_codes.archived_at,
      created_at: provider_short_codes.created_at,
      brand: {
        id: brands.id,
        name: brands.name,
        color: brands.color,
        avatar_url: brands.avatar_url,
      },
    })
    .from(provider_short_codes)
    .leftJoin(brands, eq(provider_short_codes.brand_id, brands.id))
    .where(
      and(
        eq(provider_short_codes.id, scid),
        eq(provider_short_codes.provider_id, pid),
        eq(provider_short_codes.org_id, orgId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return apiError(404, "Short code not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_short_code",
    });
  }
  return NextResponse.json({
    ...row,
    brand: row.brand && row.brand.id !== null ? row.brand : null,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string; shortCodeId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_short_codes.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId, shortCodeId } = await params;
  const pid = parseId(providerId);
  const scid = parseId(shortCodeId);
  if (pid === null || scid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  // Explicitly reject short_code changes — the column is intentionally
  // immutable post-creation. Status changes go through /status, not PATCH.
  if (
    typeof json === "object" &&
    json !== null &&
    ("short_code" in json || "status" in json)
  ) {
    return apiError(
      400,
      "short_code and status cannot be changed via PATCH",
      API_ERROR_CODES.VALIDATION,
      { field: "short_code" in (json as object) ? "short_code" : "status" },
    );
  }

  const parsed = providerShortCodeUpdateSchema.safeParse(json);
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
    .update(provider_short_codes)
    .set(updates)
    .where(
      and(
        eq(provider_short_codes.id, scid),
        eq(provider_short_codes.provider_id, pid),
        eq(provider_short_codes.org_id, orgId),
      ),
    )
    .returning();

  if (!updated[0]) {
    return apiError(404, "Short code not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_short_code",
    });
  }
  return NextResponse.json(updated[0]);
}
