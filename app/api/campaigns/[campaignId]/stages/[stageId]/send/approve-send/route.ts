import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { logCampaignEvent } from "@/lib/campaign-events";
import { runStageDrainAndRecord } from "@/lib/sends/drain-and-record";
import { kickoffStageSend, type KickoffRefusal } from "@/lib/sends/kickoff";
import { KICKOFF_REFUSAL } from "@/lib/sends/kickoff-refusals";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

class Refusal extends Error {
  constructor(public reason: KickoffRefusal) {
    super(reason);
  }
}

// Collapsed "Approve Send" commit (WS2). One operator action: approve the stage,
// materialize its send batch, and either
//   • SEND NOW (no future schedule): drain inline in this request, return the
//     real result — requires campaigns.drain (manager+, the money action), OR
//   • ARM (future schedule): materialize + mark approved, leave sent_at NULL so
//     the cron drains it when its window opens — requires campaigns.activate.
// Pre-flight should be run by the client first; kickoff is still the authoritative
// gate here (a race can surface a blocker), and a refusal rolls everything back so
// the stage is never left approved-but-empty.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "campaigns.activate")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId: cIdParam, stageId: sIdParam } = await params;
  const campaignId = parseId(cIdParam);
  const stageId = parseId(sIdParam);
  if (campaignId === null || stageId === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  // Load the stage to decide send-now vs arm-future. scheduled_at strictly in the
  // future ⇒ arm; otherwise (null or already due) ⇒ send now.
  const stageRows = (await db.execute(sql`
    SELECT s.scheduled_at AS scheduled_at, s.stage_number AS stage_number
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.id = ${stageId} AND s.campaign_id = ${campaignId} AND c.org_id = ${orgId}
    LIMIT 1
  `)) as unknown as { scheduled_at: string | null; stage_number: number }[];
  if (!stageRows[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, { entity: "stage" });
  }
  const scheduledAt = stageRows[0].scheduled_at;
  const isFuture = scheduledAt != null && new Date(scheduledAt) > new Date();
  const sendNow = !isFuture;

  // Sending inline spends money → manager+ on top of the activate bar.
  if (sendNow && !can(role, "campaigns.drain")) {
    return apiError(
      403,
      "Sending now requires manager+. Schedule the stage for a future time to arm it instead.",
      API_ERROR_CODES.FORBIDDEN,
      { reason: "send_now_requires_drain" },
    );
  }

  // Approve + materialize atomically. A kickoff refusal rolls back the approval,
  // so the stage is never left approved with no batch.
  let materialized: number;
  let mode: "manual" | "tracked";
  try {
    const r = await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE campaign_stages SET send_approved = true
        WHERE id = ${stageId} AND org_id = ${orgId}
      `);
      const k = await kickoffStageSend(tx, { orgId, campaignId, stageId });
      if (!k.ok && k.reason !== "already_pending") throw new Refusal(k.reason);

      await logCampaignEvent(tx, {
        orgId,
        campaignId,
        stageId,
        actorUserId: user.id,
        eventType: "send_approved",
        summary: `Stage ${stageRows[0].stage_number} approved to send`,
      });
      if (k.ok) {
        await logCampaignEvent(tx, {
          orgId,
          campaignId,
          stageId,
          actorUserId: user.id,
          eventType: "send_kickoff",
          summary: `Send batch materialized: ${k.materialized.toLocaleString()} recipient${k.materialized === 1 ? "" : "s"} (${k.mode})`,
          metadata: { materialized: k.materialized, mode: k.mode },
        });
      }
      return k;
    });

    if (r.ok) {
      materialized = r.materialized;
      mode = r.mode;
    } else {
      // already_pending — count the existing live batch.
      const c = (await db.execute(sql`
        SELECT count(*)::int AS n FROM stage_sends
        WHERE stage_id = ${stageId} AND status IN ('pending', 'sending')
      `)) as unknown as { n: number }[];
      materialized = Number(c[0]?.n ?? 0);
      mode = "tracked";
    }
  } catch (e) {
    if (e instanceof Refusal) {
      const m = KICKOFF_REFUSAL[e.reason];
      return apiError(
        m.status,
        m.message,
        m.status === 404 ? API_ERROR_CODES.NOT_FOUND : API_ERROR_CODES.VALIDATION,
        { reason: e.reason },
      );
    }
    throw e;
  }

  // Future schedule → armed; the cron drains it when the window opens.
  if (!sendNow) {
    return NextResponse.json({
      ok: true,
      mode,
      armed: true,
      sent_now: false,
      materialized,
      scheduled_at: scheduledAt,
    });
  }

  // Send now → drain inline and return the real result.
  const drain = await runStageDrainAndRecord(db, {
    campaignId,
    stageId,
    actorUserId: user.id,
  });

  return NextResponse.json({
    ok: true,
    mode,
    armed: false,
    sent_now: true,
    materialized,
    drain,
  });
}
