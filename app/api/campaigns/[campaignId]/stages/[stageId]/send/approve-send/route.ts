import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { logCampaignEvent } from "@/lib/campaign-events";
import { runStageDrainAndRecord } from "@/lib/sends/drain-and-record";
import { kickoffStageSend } from "@/lib/sends/kickoff";
import { KICKOFF_REFUSAL } from "@/lib/sends/kickoff-refusals";
import { can } from "@/lib/permissions";

// Materialization is windowed + resumable and can run up to its full budget.
export const maxDuration = 300;

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
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
  req: NextRequest,
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

  // Optional body: { send_now?: boolean }. The client sets it true for the
  // explicit "Prepare & send now" action (no future schedule). An empty body is
  // fine — defaults to false.
  let sendNowRequested = false;
  try {
    const body = (await req.json()) as { send_now?: unknown } | null;
    sendNowRequested = body?.send_now === true;
  } catch {
    // No/invalid body ⇒ not an explicit send-now request.
  }

  // Load the stage to decide send-now vs arm-future.
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

  // Decision:
  //   • future schedule           → ARM (cron drains when the window opens)
  //   • explicit send-now request  → SEND NOW (stamp scheduled_at = now() below)
  //   • already-due non-null date  → SEND NOW (its time has arrived)
  //   • null date, no send-now     → REJECT. A null date is never an implicit
  //     "now"; the operator must set a date or use the explicit Send now action.
  const sendNow = !isFuture && (sendNowRequested || scheduledAt != null);
  if (!isFuture && !sendNow) {
    return apiError(
      400,
      "Set a send date/time before sending (a copied stage starts with no date).",
      API_ERROR_CODES.VALIDATION,
      { reason: "no_schedule" },
    );
  }

  // Sending inline spends money → manager+ on top of the activate bar.
  if (sendNow && !can(role, "campaigns.drain")) {
    return apiError(
      403,
      "Sending now requires manager+. Schedule the stage for a future time to arm it instead.",
      API_ERROR_CODES.FORBIDDEN,
      { reason: "send_now_requires_drain" },
    );
  }

  // Explicit send-now on a not-yet-scheduled stage: stamp the send date to NOW
  // before kickoff so the pipeline's no_schedule guard passes. Immediate sends are
  // never routed through a null date.
  if (sendNow && scheduledAt == null) {
    await db.execute(sql`
      UPDATE campaign_stages SET scheduled_at = now()
      WHERE id = ${stageId} AND org_id = ${orgId}
    `);
  }

  // Materialize (windowed + resumable — own transactions, NOT wrapped here). A
  // kickoff refusal happens BEFORE any rows are inserted, so we simply return it
  // and never approve the stage (approval is stamped only on success below). This
  // gives a generous budget so an explicit action usually completes in-request.
  const k = await kickoffStageSend(db, {
    orgId,
    campaignId,
    stageId,
    budgetMs: 250_000,
  });
  if (!k.ok) {
    const m = KICKOFF_REFUSAL[k.reason];
    return apiError(
      m.status,
      m.message,
      m.status === 404 ? API_ERROR_CODES.NOT_FOUND : API_ERROR_CODES.VALIDATION,
      { reason: k.reason },
    );
  }
  const materialized = k.materialized;
  const mode = k.mode;

  // Materialization succeeded (at least partially) → approve + log. If a tick died
  // between here and the approve, the cron won't drain (Phase B needs send_approved)
  // — the operator re-approves; no partial send.
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE campaign_stages SET send_approved = true
      WHERE id = ${stageId} AND org_id = ${orgId}
    `);
    await logCampaignEvent(tx, {
      orgId,
      campaignId,
      stageId,
      actorUserId: user.id,
      eventType: "send_approved",
      summary: `Stage ${stageRows[0].stage_number} approved to send`,
    });
    await logCampaignEvent(tx, {
      orgId,
      campaignId,
      stageId,
      actorUserId: user.id,
      eventType: "send_kickoff",
      summary: k.complete
        ? `Send batch materialized: ${materialized.toLocaleString()} recipient${materialized === 1 ? "" : "s"} (${mode})`
        : `Materializing send batch in the background: ${materialized.toLocaleString()} so far (${mode})`,
      metadata: { materialized, complete: k.complete, mode },
    });
  });

  // Future schedule → armed; the cron drains it when the window opens (after
  // finishing any remaining materialization first).
  if (!sendNow) {
    return NextResponse.json({
      ok: true,
      mode,
      armed: true,
      sent_now: false,
      materialized,
      materializing: !k.complete,
      scheduled_at: scheduledAt,
    });
  }

  // Send now, but NOT fully materialized yet → do NOT drain a partial audience.
  // The cron finishes materialization (materialized_at) then drains the whole set.
  if (!k.complete) {
    return NextResponse.json({
      ok: true,
      mode,
      armed: false,
      sent_now: false,
      materializing: true,
      materialized,
    });
  }

  // Send now + fully materialized → drain inline and return the real result.
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
