import { NextResponse, type NextRequest } from "next/server";

import { runLookupWorker } from "@/lib/telnyx/worker";

// Cron-triggered Telnyx number-lookup drain. Vercel Cron hits this every 2 minutes
// (see vercel.json) with `Authorization: Bearer <CRON_SECRET>`. A single-runner
// lease inside runLookupWorker means overlapping invocations are a no-op, so a slow
// run can't multiply the effective Telnyx rate.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runLookupWorker();
  // Always 200 so the cron doesn't flap red on a benign no-lease/paused/no-work exit.
  return NextResponse.json(result);
}
