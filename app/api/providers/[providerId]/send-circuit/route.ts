import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { send_circuit_events, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// Manual control of a provider's latching send pause (the circuit breaker).
//   action: "pause"  → manual panic stop (latch the pause).
//   action: "resume" → consciously clear a pause (auto-tripped or manual).
// Every transition appends a send_circuit_events row stamped with the acting
// user — so un-pausing after a loop-trip leaves a permanent who/when record.
const bodySchema = z.object({
  action: z.enum(["pause", "resume"]),
  reason: z.string().trim().max(200).optional(),
});

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

  // Same surface as managing provider config/credentials (manager+).
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
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }
  const { action } = parsed.data;
  const reason =
    parsed.data.reason ?? (action === "pause" ? "manual panic" : null);

  const result = await db.transaction(async (tx) => {
    // Confirm ownership inside the tx; also tells pause-vs-already-paused apart.
    const existing = await tx
      .select({ id: sms_providers.id, send_paused: sms_providers.send_paused })
      .from(sms_providers)
      .where(and(eq(sms_providers.id, providerId), eq(sms_providers.org_id, orgId)))
      .limit(1);
    if (!existing[0]) return { notFound: true as const };

    const want = action === "pause";
    if (existing[0].send_paused === want) {
      // No state change — don't write a duplicate audit row.
      return { changed: false, send_paused: want };
    }

    await tx
      .update(sms_providers)
      .set({
        send_paused: want,
        send_paused_reason: want ? reason : null,
        send_paused_at: want ? new Date() : null,
      })
      .where(and(eq(sms_providers.id, providerId), eq(sms_providers.org_id, orgId)));

    await tx.insert(send_circuit_events).values({
      org_id: orgId,
      provider_id: providerId,
      event: want ? "paused" : "resumed",
      reason,
      actor_user_id: user.id,
    });

    return { changed: true, send_paused: want };
  });

  if ("notFound" in result) {
    return apiError(404, "Provider not found", API_ERROR_CODES.NOT_FOUND, { entity: "provider" });
  }
  return NextResponse.json({ ok: true, ...result });
}
