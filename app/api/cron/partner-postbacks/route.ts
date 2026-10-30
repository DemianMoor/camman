import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { withCronLease } from "@/lib/cron/lease";
import { deliveryEnabled, runPostbackDelivery } from "@/lib/partners/postbacks/deliver";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";

// Partner sales postback delivery, every 5 minutes. Kill switch:
// PARTNER_POSTBACKS_DELIVERY_ENABLED=true. Switch off ⇒ no claim, no send, and
// the ONLY write is the heartbeat (so a deliberately-off switch is not read as
// a dead cron). The heartbeat is watched by /api/cron/drip-monitors.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LEASE_MS = 90_000; // > maxDuration, so a killed run's lease expires before the next tick

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    if (!deliveryEnabled()) {
      await recordHeartbeat(db, HEARTBEAT_JOBS.partnerPostbacks.job_name);
      return NextResponse.json({ ok: true, skipped_kill_switch: true });
    }
    const outcome = await withCronLease("partner-postbacks", () => runPostbackDelivery(), LEASE_MS);
    if (!outcome.ran) {
      return NextResponse.json({ ok: true, skipped: true, skippedCount: outcome.skippedCount });
    }
    // Stamped AFTER the work so a run that threw does not look healthy.
    await recordHeartbeat(db, HEARTBEAT_JOBS.partnerPostbacks.job_name);
    console.log(`[partner-postbacks] ${JSON.stringify(outcome.result)}`);
    return NextResponse.json({ ok: true, ...outcome.result });
  } catch (err) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    // Partner URLs carry tokens: strip anything URL-shaped from the alert text.
    const message = (err instanceof Error ? err.message : String(err)).replace(/\b\w+:\/\/\S+/g, "<url>").slice(0, 300);
    console.error(`[partner-postbacks] FAILED after ${elapsed}s:`, message);
    await notifyTelegram(`🔴 Tier-1: partner-postbacks delivery FAILED after ${elapsed}s\nError: ${message}`);
    return NextResponse.json({ error: "partner_postbacks_failed", detail: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
