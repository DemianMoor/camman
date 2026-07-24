import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { runSendPreflight } from "@/lib/sends/send-preflight";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// P5 — send-preflight cron (*/5, leads each send-scheduled tick). ~15 min before
// a scheduled stage materializes, computes + persists its resolved-audience +
// exclusion breakdown and posts a Telegram digest (+ standalone red alerts).
// Post-once per stage via preflight_notified_at. Read-mostly (only stamps the
// preflight_* columns) — it never sends SMS.
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runSendPreflight(db);
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
