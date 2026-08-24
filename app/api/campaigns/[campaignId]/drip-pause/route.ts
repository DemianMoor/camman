import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { acceptDripRisk } from "@/lib/drip/optout-monitor";
import { latchCampaignPause } from "@/lib/sends/circuit-breakers";
import { can } from "@/lib/permissions";
import { sql as drizzleSql } from "drizzle-orm";

// Pause / resume a DRIP campaign (Drip Phase 5).
//
// Two distinct actions on one latch, and keeping them distinct is the point:
//
//   action=pause   — an operator stopping the campaign. Journeys keep
//                    accumulating; only sending stops.
//   action=resume  — plain resume of an operator pause.
//   action=accept_risk — clear a latch the DRIP OPT-OUT MONITOR set.
//
// ⚠️ `accept_risk` REFUSES to clear any other kind of latch. campaigns.send_paused
// is shared with the failure-spike breaker and the regular opt-out breaker; an
// override that cleared it unconditionally would let someone wave away a genuine
// provider-failure trip from a drip screen, with the button labelled as though it
// only concerned drip. acceptDripRisk checks the reason string and leaves a
// non-drip latch exactly as it is.
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;
  if (!can(role, "campaigns.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const { campaignId: raw } = await params;
  const cid = Number(raw);
  if (!Number.isInteger(cid) || cid <= 0) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  let body: { action?: string } = {};
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const action = body.action;

  const rows = await db.execute(drizzleSql`
    SELECT id, type, send_paused, send_paused_reason
    FROM campaigns WHERE id = ${cid} AND org_id = ${orgId}::uuid LIMIT 1
  `);
  const camp = rows[0] as
    | { id: number; type: string; send_paused: boolean; send_paused_reason: string | null }
    | undefined;
  if (!camp) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, { entity: "campaign" });
  }
  if (camp.type !== "drip") {
    return apiError(400, "This campaign is not a drip campaign", API_ERROR_CODES.VALIDATION, {
      field: "type",
    });
  }

  if (action === "pause") {
    const latched = await latchCampaignPause(db, {
      campaignId: cid,
      orgId,
      reason: "operator paused (drip)",
      actorUserId: user.id,
    });
    return NextResponse.json({ ok: true, paused: true, changed: latched });
  }

  if (action === "accept_risk") {
    const r = await acceptDripRisk({ orgId, campaignId: cid, actorUserId: user.id });
    if (!r.cleared) {
      return apiError(
        409,
        r.refusedBecause === "latch_not_set_by_drip_monitor"
          ? `This campaign is paused by something other than the drip opt-out monitor ` +
            `(${r.reason ?? "unknown"}). Resolve that first — this action only clears a drip ` +
            `opt-out latch.`
          : r.refusedBecause === "not_paused"
            ? "This campaign is not paused."
            : "Could not accept risk for this campaign.",
        API_ERROR_CODES.VALIDATION,
        { reason: r.refusedBecause },
      );
    }
    return NextResponse.json({ ok: true, paused: false, cleared_reason: r.reason });
  }

  if (action === "resume") {
    // A plain resume only clears an OPERATOR pause. A breaker trip must go
    // through accept_risk (or the provider/campaign resume flow), so a human
    // cannot clear a safety latch by clicking the everyday button.
    if (camp.send_paused && !camp.send_paused_reason?.startsWith("operator paused")) {
      return apiError(
        409,
        `This campaign was paused automatically (${camp.send_paused_reason ?? "unknown"}), ` +
          `not by an operator. Use "accept risk and proceed" if that is intended.`,
        API_ERROR_CODES.VALIDATION,
        { reason: "not_an_operator_pause" },
      );
    }
    await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE campaigns SET send_paused = false, send_paused_reason = NULL, send_paused_at = NULL
        WHERE id = ${cid} AND org_id = ${orgId}::uuid
      `);
      await tx.execute(drizzleSql`
        INSERT INTO campaign_circuit_events (org_id, campaign_id, event, reason, actor_user_id)
        VALUES (${orgId}::uuid, ${cid}, 'resumed', 'operator resumed (drip)', ${user.id})
      `);
    });
    return NextResponse.json({ ok: true, paused: false });
  }

  return apiError(400, "action must be pause, resume or accept_risk", API_ERROR_CODES.VALIDATION, {
    field: "action",
  });
}
