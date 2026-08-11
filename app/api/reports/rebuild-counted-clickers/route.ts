import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { withCronLease } from "@/lib/cron/lease";
import { can } from "@/lib/permissions";
import { notifyTelegram } from "@/lib/alerts/telegram";
import {
  HEARTBEAT_JOBS,
  checkHeartbeats,
  heartbeatBreaches,
} from "@/lib/reporting/cron-heartbeat";
import { refreshCountedClickers } from "@/lib/reporting/counted-clickers";

// Daily FULL rebuild of the counted-clicker cache (the EPC denominator).
//
// The incremental pass rides the Keitaro poll every 5 minutes so the denominator
// advances in step with the revenue numerator (see lib/reporting/counted-clickers.ts).
// That pass is additive only, so it cannot remove a row whose click was
// reclassified away from 'human'. This job is the repair path: a wholesale
// rebuild that makes any correction to click classification self-heal without a
// backfill — the failure mode that left `clickers` permanently wrong when the
// 2026-08-11 rescore landed behind its watermark.
export const dynamic = "force-dynamic";
// A full rebuild measured ~23s from a laptop over the pooler; in-region it is
// far less. Seatbelt only.
export const maxDuration = 300;
export const preferredRegion = "fra1";

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches =
    !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    // Rebuilding a reporting cache is an import-shaped action (operator+).
    if (!can(auth.role, "result_imports.create")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  if (bearerMatches) {
    // Dead-man check: this DAILY job watches the WEEKLY monitors, so if they
    // stop, it is noticed within a day rather than never. refreshCountedClickers
    // stamps this job's own heartbeat via cron_locks on a full pass.
    const heartbeats = await checkHeartbeats(db, [HEARTBEAT_JOBS.epcMonitors]);
    const stale = heartbeatBreaches(heartbeats);
    if (stale.length > 0) {
      try {
        await notifyTelegram(
          ["⚠️ *Cron heartbeat*", "", ...stale.map((s) => `• ${s}`)].join("\n"),
        );
      } catch (err) {
        console.error("[rebuild-counted-clickers] heartbeat alert failed", err);
      }
    }

    const leased = await withCronLease("counted-clickers-full", () =>
      refreshCountedClickers(db, "full"),
    );
    if (!leased.ran) {
      return NextResponse.json({
        skipped: true,
        reason: "prior_run_in_progress",
        skippedCount: leased.skippedCount,
      });
    }
    return NextResponse.json(leased.result);
  }

  return NextResponse.json(await refreshCountedClickers(db, "full"));
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
