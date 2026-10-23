import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { withCronLease } from "@/lib/cron/lease";
import { ONESHOT, runLifecycleBackfillTick } from "@/lib/engagement/lifecycle-backfill-oneshot";

// The one-shot Lifecycle backfill, 2026-10-24 05:00–06:20 UTC
// (lib/engagement/lifecycle-backfill-oneshot.ts). Scheduled every 5 minutes in
// hours 05–06 UTC (vercel.json); every tick outside that window — and every
// tick after the run has finished — is a no-op, so the entry is inert after
// tonight and can be removed in any later PR.
//
// CRON_SECRET only: there is no human path. A backfill must not be startable
// from a browser.
export const dynamic = "force-dynamic";
export const maxDuration = 800;

// > maxDuration: a killed function's SQL keeps running server-side, so the
// lease must outlive it before the next tick may start a unit.
const LEASE_MS = 14 * 60 * 1000;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const outcome = await withCronLease(
    ONESHOT.key,
    () =>
      runLifecycleBackfillTick({
        db,
        orgId: ONESHOT.orgId,
        now: () => new Date(),
        notify: notifyTelegram,
      }),
    LEASE_MS,
  );
  if (!outcome.ran) return NextResponse.json({ ok: true, skipped: "lease held" });
  return NextResponse.json({ ok: true, ...outcome.result });
}

export const GET = handle;
export const POST = handle;
