import { type NextRequest, NextResponse } from "next/server";

import { withCronLease } from "@/lib/cron/lease";
import { deliveryEnabled, runPostbackDelivery } from "@/lib/partners/postbacks/deliver";

// Partner sales postback delivery, every 5 minutes. Kill switch:
// PARTNER_POSTBACKS_DELIVERY_ENABLED=true, checked BEFORE the lease so an
// off switch touches nothing (not even cron_locks).
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
  if (!deliveryEnabled()) return NextResponse.json({ ok: true, skipped_kill_switch: true });

  try {
    const outcome = await withCronLease("partner-postbacks", () => runPostbackDelivery(), LEASE_MS);
    if (!outcome.ran) {
      return NextResponse.json({ ok: true, skipped: true, skippedCount: outcome.skippedCount });
    }
    console.log(`[partner-postbacks] ${JSON.stringify(outcome.result)}`);
    return NextResponse.json({ ok: true, ...outcome.result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[partner-postbacks] FAILED:", err);
    return NextResponse.json({ error: "partner_postbacks_failed", detail: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
