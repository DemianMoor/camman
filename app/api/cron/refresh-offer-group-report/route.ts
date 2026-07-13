import { type NextRequest, NextResponse } from "next/server";

import { notifyTelegram } from "@/lib/alerts/telegram";
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

  const startedAt = Date.now();
  try {
    const durations = await refreshOfferGroupReport();
    // Log runtime every run so we can watch it grow toward the 300s ceiling.
    console.log(
      `[refresh-offer-group-report] ok summaryMs=${durations.summaryMs} groupMs=${durations.groupMs} totalMs=${durations.totalMs}`,
    );
    return NextResponse.json({ ok: true, durations });
  } catch (err) {
    // Previously this failed silently against a growing ~27s refresh. Fire a
    // Tier-1 Telegram alert with duration + error, then surface a 500 so the
    // scheduler flags red too. notifyTelegram is best-effort (never throws);
    // awaiting it ensures delivery before the serverless invocation ends.
    const elapsedMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[refresh-offer-group-report] FAILED after ${elapsedMs}ms:`,
      err,
    );
    await notifyTelegram(
      `🔴 Tier-1: offer-group-report matview refresh FAILED after ${(
        elapsedMs / 1000
      ).toFixed(1)}s\nError: ${message}`,
    );
    return NextResponse.json(
      { error: "refresh_failed", detail: message },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
