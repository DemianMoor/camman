import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { provider_phones } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { providerPhoneStatusChangeSchema } from "@/lib/validators/provider-phones";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function POST(
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

  const parsed = providerPhoneStatusChangeSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Check current state — archived phones must be restored first.
  const existing = await db
    .select({ status: provider_phones.status })
    .from(provider_phones)
    .where(
      and(
        eq(provider_phones.id, phid),
        eq(provider_phones.provider_id, pid),
        eq(provider_phones.org_id, orgId),
      ),
    )
    .limit(1);

  if (!existing[0]) {
    return apiError(404, "Phone not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_phone",
    });
  }

  if (existing[0].status === "archived") {
    return apiError(
      409,
      "Phone is archived — restore it first",
      API_ERROR_CODES.CONFLICT,
      { reason: "phone_is_archived" },
    );
  }

  const updated = await db
    .update(provider_phones)
    .set({ status: parsed.data.status })
    .where(
      and(
        eq(provider_phones.id, phid),
        eq(provider_phones.provider_id, pid),
        eq(provider_phones.org_id, orgId),
      ),
    )
    .returning();

  return NextResponse.json(updated[0]);
}
