import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { send_circuit_events, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { providerSendsEnabledSchema } from "@/lib/validators/providers";

// The `sends_enabled` posture switch — "should this account be sending right
// now", answered by a human (migration 0138).
//
// Its own endpoint, deliberately, exactly like `supports_api_send` and
// `send_paused` before it: the provider PATCH takes a whole-object body from a
// form that re-submits every field on every save with no concurrency check, so
// a stale page could write back a value a deliberate act had already changed.
// That is how `supports_api_send` silently re-enabled itself on `tls`
// (2026-08-13, ClickUp 869ehjwtf). A field that decides whether SMS goes out
// does not live on a bulk settings form.
//
// ⚠️ This is NOT the circuit breaker. `send_paused` is the auto-tripped latch
// and keeps its own verbs ('paused'/'resumed'); this writes
// 'sends_enabled_on'/'sends_enabled_off' (migration 0139) so an automated trip
// and an operator's decision stay distinguishable in the history. Turning
// sends_enabled back on does NOT clear a tripped breaker, and vice versa — the
// drain requires both.
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

  // Same surface as the api-send gate and the send-circuit endpoint this mirrors.
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
  const parsed = providerSendsEnabledSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const { enabled } = parsed.data;
  const reason = parsed.data.reason ?? null;

  const result = await db.transaction(async (tx) => {
    // Ownership confirmed inside the tx, and the current value read so an
    // already-in-that-state call doesn't write a misleading audit row.
    const existing = await tx
      .select({ id: sms_providers.id, sends_enabled: sms_providers.sends_enabled })
      .from(sms_providers)
      .where(and(eq(sms_providers.id, providerId), eq(sms_providers.org_id, orgId)))
      .limit(1);
    if (!existing[0]) return { notFound: true as const };

    if (existing[0].sends_enabled === enabled) {
      return { changed: false, sends_enabled: enabled };
    }

    await tx
      .update(sms_providers)
      .set({ sends_enabled: enabled })
      .where(and(eq(sms_providers.id, providerId), eq(sms_providers.org_id, orgId)));

    await tx.insert(send_circuit_events).values({
      org_id: orgId,
      provider_id: providerId,
      event: enabled ? "sends_enabled_on" : "sends_enabled_off",
      reason,
      actor_user_id: user.id,
    });

    return { changed: true, sends_enabled: enabled };
  });

  if ("notFound" in result) {
    return apiError(404, "Provider not found", API_ERROR_CODES.NOT_FOUND, { entity: "provider" });
  }
  return NextResponse.json({ ok: true, ...result });
}
