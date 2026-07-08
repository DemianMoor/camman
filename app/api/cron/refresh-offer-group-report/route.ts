import { type NextRequest, NextResponse } from "next/server";

import { refreshOfferGroupReport } from "@/lib/reporting/offer-group-report";

export const dynamic = "force-dynamic";
// Task 2 measured the full CONCURRENTLY refresh at ~50s worst-case (cold) / ~37s
// warm. 60s left no cold-start headroom, so this cron gets a larger budget. It is
// a background job (not user-facing), so a longer ceiling costs nothing.
export const maxDuration = 300;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await refreshOfferGroupReport();
  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
