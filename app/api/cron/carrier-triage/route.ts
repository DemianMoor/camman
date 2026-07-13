import { type NextRequest, NextResponse } from "next/server";

import { notifyTelegram } from "@/lib/alerts/telegram";
import { runCarrierTriage } from "@/lib/carrier/ai-triage";
import { withCronLease } from "@/lib/cron/lease";

export const dynamic = "force-dynamic";
// Background job. AI triage batches 50 strings/call to a fast model; a run drains
// the whole pending queue but is bounded by the per-run API-call cap. 60s is ample
// for the steady state (the queue trends to empty as the mapping table matures).
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const outcome = await withCronLease("carrier-triage", runCarrierTriage);
    if (!outcome.ran) {
      // Overlap with a prior run — expected backpressure, not an incident.
      return NextResponse.json({ ok: true, skipped: true });
    }
    const s = outcome.result;
    console.log(
      `[carrier-triage] ok mapped=${s.newlyMapped} needHuman=${s.needHuman} apiCalls=${s.apiCalls}${s.stoppedReason ? ` stopped=${s.stoppedReason}` : ""}`,
    );
    return NextResponse.json({ ok: true, ...s });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[carrier-triage] FAILED:", err);
    await notifyTelegram(`🔴 Tier-1: carrier AI triage cron FAILED\nError: ${message}`);
    return NextResponse.json({ error: "triage_failed", detail: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
