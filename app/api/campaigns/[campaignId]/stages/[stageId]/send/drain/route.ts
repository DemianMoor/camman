import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
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
  const sessionRole = bearerMatches
    ? null
    : await (async () => {
        const auth = await requireApiMembership();
        return "error" in auth ? null : auth.role;
      })();

  const decision = decideDrainAuth({ bearerMatches, sessionRole });
  if (!decision.allow) {
    return NextResponse.json(
      { error: decision.status === 401 ? "Unauthorized" : "Forbidden" },
      { status: decision.status },
    );
  }

  const { stageId: sParam } = await params;
  const stageId = parseId(sParam);
  if (stageId === null) {
    return NextResponse.json({ error: "Invalid stage id" }, { status: 400 });
  }

  const result = await runStageDrain(db, { stageId });

  if (!result.ok && result.reason) {
    const r = REFUSAL[result.reason];
    return NextResponse.json({ error: r.message, reason: result.reason }, { status: r.status });
  }
  return NextResponse.json(result);
}
