import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { campaign_circuit_events, campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// P7/P8 — manual control of a campaign's latching send pause. Mirrors the
// provider send-circuit route, on the campaign row + campaign_circuit_events:
//   action: "pause"  → manually latch (independent of the provider latch).
//   action: "resume" → clear a pause (auto-tripped by the opt-out-rate breaker,
//                      or manual). The ONLY way to clear the latch.
// Every transition appends an audit row stamped with the acting user. Orthogonal
// to campaigns.status — this never changes the lifecycle state.
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
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "campaigns.pause")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId: cParam } = await params;
  const campaignId = parseId(cParam);
  if (campaignId === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION, { field: "id" });
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
  const reason = parsed.data.reason ?? (action === "pause" ? "manual" : null);

  const result = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: campaigns.id, send_paused: campaigns.send_paused })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)))
      .limit(1);
    if (!existing[0]) return { notFound: true as const };

    const want = action === "pause";
    if (existing[0].send_paused === want) {
      return { changed: false, send_paused: want };
    }

    await tx
      .update(campaigns)
      .set({
        send_paused: want,
        send_paused_reason: want ? reason : null,
        send_paused_at: want ? new Date() : null,
      })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)));

    await tx.insert(campaign_circuit_events).values({
      org_id: orgId,
      campaign_id: campaignId,
      event: want ? "paused" : "resumed",
      reason,
      actor_user_id: user.id,
    });

    return { changed: true, send_paused: want };
  });

  if ("notFound" in result) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, { entity: "campaign" });
  }
  return NextResponse.json({ ok: true, ...result });
}
