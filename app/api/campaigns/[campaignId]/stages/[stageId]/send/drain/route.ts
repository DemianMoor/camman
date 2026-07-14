import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { decideDrainAuth, type DrainRefusal } from "@/lib/sends/drain";
import { runStageDrainAndRecord } from "@/lib/sends/drain-and-record";

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
  send_disabled_org: {
    status: 403,
    message: "Live SMS sending is off — turn it on in Settings → Sending",
  },
  send_paused_org: {
    status: 409,
    message: "Sending is paused (hard-stop engaged) — click Proceed on Today's sends to resume",
  },
  provider_paused: {
    status: 409,
    message: "Sending is paused for this provider (circuit breaker engaged)",
  },
  no_provider: { status: 400, message: "Stage has no SMS provider" },
  unknown_provider: {
    status: 400,
    message: "Stage's SMS provider has no registered adapter",
  },
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

  const result = await runStageDrainAndRecord(db, { campaignId, stageId, actorUserId });

  if (!result.ok && result.reason) {
    const r = REFUSAL[result.reason];
    return NextResponse.json({ error: r.message, reason: result.reason }, { status: r.status });
  }

  return NextResponse.json(result);
}
