import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { provider_short_codes } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { providerShortCodeStatusChangeSchema } from "@/lib/validators/provider-short-codes";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function POST(
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

  const parsed = providerShortCodeStatusChangeSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Check current state — archived short codes must be restored first.
  const existing = await db
    .select({ status: provider_short_codes.status })
    .from(provider_short_codes)
    .where(
      and(
        eq(provider_short_codes.id, scid),
        eq(provider_short_codes.provider_id, pid),
        eq(provider_short_codes.org_id, orgId),
      ),
    )
    .limit(1);

  if (!existing[0]) {
    return apiError(404, "Short code not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_short_code",
    });
  }

  if (existing[0].status === "archived") {
    return apiError(
      409,
      "Short code is archived — restore it first",
      API_ERROR_CODES.CONFLICT,
      { reason: "short_code_is_archived" },
    );
  }

  const updated = await db
    .update(provider_short_codes)
    .set({ status: parsed.data.status })
    .where(
      and(
        eq(provider_short_codes.id, scid),
        eq(provider_short_codes.provider_id, pid),
        eq(provider_short_codes.org_id, orgId),
      ),
    )
    .returning();

  return NextResponse.json(updated[0]);
}
