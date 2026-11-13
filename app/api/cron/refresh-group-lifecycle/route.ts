import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { withCronLease } from "@/lib/cron/lease";
import { ENGAGEMENT_GROUP_ROLLUP_JOB } from "@/lib/engagement/constants";
import { orgsWithEngineOn } from "@/lib/engagement/settings";
import { recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
import {
  groupLifecycleLeaseKey,
  refreshGroupLifecycleRollup,
} from "@/lib/reporting/group-lifecycle-store";

// The Group × Lifecycle table (migration 0193) — HOURLY at :13 (owner,
// 2026-11-13). Until then the 15-minute engagement job recomputed it after
// every recount; it now has its own route and schedule, three minutes after
// the :10 engagement tick so that tick's statuses are usually committed.
//
// Same orgs as the engagement job (lifecycle_settings.engine_mode = 'write'):
// the table reads contacts.lifecycle_status, which only that job maintains.
//
// ⚠️ ONE LEASE PER ORG, SHARED WITH THE "Refresh now" BUTTON
// (groupLifecycleLeaseKey). If a click is computing when the cron fires, the
// cron skips that org — the click is producing the same table — and the skip
// does not withhold the heartbeat. The heartbeat keeps its historical name
// (contact-engagement-group-rollup) so the existing watch and its cron_locks
// row carry over; it now tolerates 2.5 h (two missed hourly runs).
//
// Each org computes and stores in ONE transaction (refreshGroupLifecycleRollup):
// the old rows stay readable until the new ones commit.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Per org. Under maxDuration so a runaway compute ends in a 57014, not a kill.
const BUDGET_MS = 240_000;
// > maxDuration: a killed function's SQL keeps running until its timeout.
const LEASE_MS = 6 * 60 * 1000;

type OrgResult = { org_id: string; rows?: number; durationMs?: number; skipped?: true; error?: string };

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: OrgResult[] = [];
  for (const org_id of await orgsWithEngineOn(db)) {
    // One org's failure must not stop the rest; it withholds the heartbeat.
    try {
      const outcome = await withCronLease(
        groupLifecycleLeaseKey(org_id),
        () =>
          db.transaction((tx) =>
            refreshGroupLifecycleRollup(tx, { orgId: org_id, deadline: Date.now() + BUDGET_MS }),
          ),
        LEASE_MS,
      );
      if (!outcome.ran) {
        results.push({ org_id, skipped: true });
        continue;
      }
      console.info("[group-lifecycle] rollup", { org_id, ...outcome.result });
      results.push({ org_id, ...outcome.result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error("[group-lifecycle] rollup failed", { org_id, error });
      results.push({ org_id, error });
    }
  }

  const ok = results.every((r) => !r.error);
  if (ok) await recordHeartbeat(db, ENGAGEMENT_GROUP_ROLLUP_JOB);
  return NextResponse.json(
    { ok, results, ts: new Date().toISOString() },
    { status: ok ? 200 : 500 },
  );
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
