import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import {
  LEASE_JOB,
  runFullRebuild,
  runIncremental,
  runTrailingRebuild,
  type FullRebuildResult,
  type IncrementalResult,
  type TrailingRebuildResult,
} from "@/lib/carrier-rejection/ledger";
import { withCronLease } from "@/lib/cron/lease";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";

// Carrier-rejected numbers ledger (migration 0225, ClickUp 1amdve2850v).
//   default        incremental: receipts since the watermark, every 15 min
//   ?mode=rebuild  DAILY: re-derive the last 14 days of receipts + recompute the
//                  whole flagged set (drift repair)
//   ?mode=full     ON DEMAND: re-derive ALL receipt history — the initial
//                  backfill, and the repair after a code-map change. Resumable:
//                  returns complete:false when its budget runs out; call again.
// The incremental and daily passes refuse until one full rebuild completed.
// All modes share ONE lease, so they never overlap. Alerts on FAILURE only
// (Tier-1 Telegram + 500); a no-show is caught by the heartbeats, which
// tells-monitors watches.
export const dynamic = "force-dynamic";
export const maxDuration = 800;
export const preferredRegion = "fra1";

const FULL_BUDGET_MS = 600_000; // then return complete:false; the next call resumes
const LEASE_MS = 14 * 60 * 1000; // > maxDuration, so a killed run's lease expires

type Mode = "incremental" | "rebuild" | "full";
type Result = IncrementalResult | TrailingRebuildResult | FullRebuildResult;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = req.nextUrl.searchParams.get("mode");
  const mode: Mode = q === "rebuild" ? "rebuild" : q === "full" ? "full" : "incremental";
  const startedAt = Date.now();
  try {
    const outcome = await withCronLease<Result>(
      LEASE_JOB,
      () =>
        mode === "full"
          ? runFullRebuild(db, { budgetMs: FULL_BUDGET_MS })
          : mode === "rebuild"
            ? runTrailingRebuild(db)
            : runIncremental(db),
      LEASE_MS,
    );
    if (!outcome.ran) {
      return NextResponse.json({ ok: true, mode, skipped: true, skippedCount: outcome.skippedCount });
    }
    const r = outcome.result;
    console.log(`[carrier-rejections] ok mode=${mode} ${JSON.stringify(r)}`);
    // Stamp only work that actually happened: a pass that refused (no full
    // rebuild yet) leaves its heartbeat to age, which is the point.
    if ("ran" in r && r.ran) {
      await recordHeartbeat(
        db,
        mode === "rebuild"
          ? HEARTBEAT_JOBS.carrierRejectionRebuild.job_name
          : HEARTBEAT_JOBS.carrierRejectionIncremental.job_name,
      );
    }
    return NextResponse.json({ ok: true, mode, ...r });
  } catch (err) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[carrier-rejections] FAILED mode=${mode} after ${elapsed}s:`, err);
    await notifyTelegram(`🔴 Tier-1: carrier-rejections ${mode} FAILED after ${elapsed}s\nError: ${message}`);
    return NextResponse.json({ error: "carrier_rejections_failed", detail: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
