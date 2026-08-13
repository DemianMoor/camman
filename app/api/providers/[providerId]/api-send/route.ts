import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { send_circuit_events, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { providerApiSendSchema } from "@/lib/validators/providers";

// The `supports_api_send` go-live gate — whether this provider may send live
// SMS at all.
//
// It lives here, NOT on the provider PATCH, for the same reason `send_paused`
// does: that endpoint takes a whole-object body from a form that re-submits
// every field on every save with no concurrency check, so a stale page could
// (and did — `tls`, 2026-08-13, ClickUp 869ehjwtf) write back a `true` that a
// deliberate act had already cleared. A gate that fails OPEN cannot live on a
// bulk settings form.
//
// Every transition appends a send_circuit_events row stamped with the acting
// user, so "who turned sending on for this provider, and when" has an answer.
// Before this endpoint it did not: sms_providers has no `updated_at` and
// nothing audited the column.
function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  // Same surface as managing provider config/credentials (manager+), matching
  // the send-circuit endpoint this mirrors.
  if (!can(role, "providers.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId: pParam } = await params;
  const providerId = parseId(pParam);
  if (providerId === null) {
    return apiError(400, "Invalid provider id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = providerApiSendSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }
  const { enabled } = parsed.data;
  const reason = parsed.data.reason ?? null;

  const result = await db.transaction(async (tx) => {
    // Confirm ownership inside the tx, and read the current value so an
    // already-in-that-state call doesn't write a misleading audit row.
    const existing = await tx
      .select({ id: sms_providers.id, supports_api_send: sms_providers.supports_api_send })
      .from(sms_providers)
      .where(and(eq(sms_providers.id, providerId), eq(sms_providers.org_id, orgId)))
      .limit(1);
    if (!existing[0]) return { notFound: true as const };

    if (existing[0].supports_api_send === enabled) {
      return { changed: false, supports_api_send: enabled };
    }

    await tx
      .update(sms_providers)
      .set({ supports_api_send: enabled })
      .where(and(eq(sms_providers.id, providerId), eq(sms_providers.org_id, orgId)));

    await tx.insert(send_circuit_events).values({
      org_id: orgId,
      provider_id: providerId,
      event: enabled ? "api_send_enabled" : "api_send_disabled",
      reason,
      actor_user_id: user.id,
    });

    return { changed: true, supports_api_send: enabled };
  });

  if ("notFound" in result) {
    return apiError(404, "Provider not found", API_ERROR_CODES.NOT_FOUND, { entity: "provider" });
  }
  return NextResponse.json({ ok: true, ...result });
}
