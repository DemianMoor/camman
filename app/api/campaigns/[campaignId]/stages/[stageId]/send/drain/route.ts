import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { runStageDrain, type DrainRefusal } from "@/lib/sends/drain";

// Real-send drain for one stage. Owner-triggered, explicit (NOT an always-on
// cron). Three gates: CRON_SECRET on this endpoint, the SEND_ENABLED env
// kill-switch (re-checked between batches in runStageDrain), and the per-stage
// send_approved flag. No SMS goes out unless all three pass + credentials
// resolve.
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
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
