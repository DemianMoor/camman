import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { sms_providers } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { nullIfEmpty, providerUpdateSchema } from "@/lib/validators/providers";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const NULLABLE_OPTIONAL_STRING = new Set([
  "short_link_example",
  "avatar_url",
  "color",
]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "providers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId } = await params;
  const id = parseId(providerId);
  if (id === null) {
    return apiError(400, "Invalid provider id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select()
    .from(sms_providers)
    .where(and(eq(sms_providers.id, id), eq(sms_providers.org_id, orgId)))
    .limit(1);

  if (!rows[0]) {
    return apiError(404, "Provider not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider",
    });
  }
  return NextResponse.json(rows[0]);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "providers.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId } = await params;
  const id = parseId(providerId);
  if (id === null) {
    return apiError(400, "Invalid provider id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = providerUpdateSchema.safeParse(json);
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
    updates[k] = NULLABLE_OPTIONAL_STRING.has(k) ? nullIfEmpty(v as string) : v;
  }

  try {
    const updated = await db
      .update(sms_providers)
      .set(updates)
      .where(and(eq(sms_providers.id, id), eq(sms_providers.org_id, orgId)))
      .returning();

    if (!updated[0]) {
      return apiError(404, "Provider not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "provider",
      });
    }
    return NextResponse.json(updated[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A provider with this sms_provider_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "sms_provider_id" },
      );
    }
    throw err;
  }
}
