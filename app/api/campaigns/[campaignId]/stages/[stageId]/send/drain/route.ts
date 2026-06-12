import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { logCampaignEvent } from "@/lib/campaign-events";
import { decideDrainAuth, runStageDrain, type DrainRefusal } from "@/lib/sends/drain";

// Real-send drain for one stage. Owner-triggered, explicit (NOT an always-on
// cron). Three gates inside runStageDrain: SEND_ENABLED env kill-switch
// (re-checked between batches) + the per-stage send_approved flag + resolvable
// credentials.
//
// Auth is DUAL (gate only — drain logic is unchanged): either a matching
// CRON_SECRET Bearer (programmatic/cron) OR an authenticated session with
// manager+ (campaigns.drain). The browser uses its session cookie, so the
// CRON_SECRET is never exposed to the client. A request with neither is
// rejected (decideDrainAuth — see verify-drain's auth-gap test).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const REFUSAL: Record<DrainRefusal, { status: number; message: string }> = {
  not_found: { status: 404, message: "Stage not found" },
  not_approved: { status: 409, message: "Stage isn't approved to send" },
  send_disabled: { status: 403, message: "Sending is disabled (SEND_ENABLED is off)" },
  provider_paused: {
    status: 409,
    message: "Sending is paused for this provider (circuit breaker engaged)",
  },
  no_provider: { status: 400, message: "Stage has no SMS provider" },
  no_credentials: {
    status: 400,
    message: "No API credentials for the stage's provider/brand",
  },
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const secret = process.env.CRON_SECRET;
  const bearerMatches = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  // Only resolve the session when the Bearer didn't already authorize (cron).
  // Capture the acting user for the activity log; a cron-driven drain has none.
  const session = bearerMatches ? null : await requireApiMembership();
  const sessionOk = session != null && !("error" in session);
  const sessionRole = sessionOk ? session.role : null;
  const actorUserId = sessionOk ? session.user.id : null;

  const decision = decideDrainAuth({ bearerMatches, sessionRole });
  if (!decision.allow) {
    return NextResponse.json(
      { error: decision.status === 401 ? "Unauthorized" : "Forbidden" },
      { status: decision.status },
    );
  }

  const { campaignId: cParam, stageId: sParam } = await params;
  const campaignId = parseId(cParam);
  const stageId = parseId(sParam);
  if (campaignId === null || stageId === null) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const result = await runStageDrain(db, { stageId });

  if (!result.ok && result.reason) {
    const r = REFUSAL[result.reason];
    return NextResponse.json({ error: r.message, reason: result.reason }, { status: r.status });
  }

  // Manual "Send now" backfill: once rows were actually attempted, stamp
  // scheduled_at (if it was empty — immediate send) AND sent_at in ONE
  // statement, so there's never a window where scheduled_at is set but sent_at
  // is null for the send-scheduled cron to grab. sent_at also locks the stage's
  // Scheduled field (see CLAUDE.md §10g / lib/quiet-hours.ts). COALESCE keeps a
  // pre-existing scheduled_at and is idempotent across re-drains.
  if (result.ok && result.processed > 0) {
    // RETURNING org_id + stage_number so the activity log below has its tenant
    // and a human label — the drain (cron-capable) carries no auth orgId.
    const stamp = (await db.execute(sql`
      UPDATE campaign_stages
      SET scheduled_at = COALESCE(scheduled_at, now()),
          sent_at = COALESCE(sent_at, now())
      WHERE id = ${stageId}
      RETURNING org_id, stage_number
    `)) as unknown as { org_id: string; stage_number: number }[];

    // Audit only runs that actually attempted sends — the */15 cron ticks past
    // idle stages constantly, and a "0 processed" event every tick is noise.
    const orgId = stamp[0]?.org_id;
    if (orgId) {
      const stopped = result.stopReason ? ` · stopped: ${result.stopReason}` : "";
      await logCampaignEvent(db, {
        orgId,
        campaignId,
        stageId,
        actorUserId,
        eventType: "send_drain",
        summary: `Stage ${stamp[0].stage_number} send run: ${result.sent.toLocaleString()} sent, ${result.failed} failed${stopped}`,
        metadata: {
          sent: result.sent,
          failed: result.failed,
          processed: result.processed,
          remaining: result.remaining,
          stopReason: result.stopReason,
          pausedNow: result.pausedNow,
        },
      });
    }
  }

  return NextResponse.json(result);
}
