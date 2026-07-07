import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { reconcileStuckStages } from "@/lib/sends/reconcile-stages";
import { runScheduledSends } from "@/lib/sends/scheduled";

// Fires DUE scheduled sends for API (tracked) campaigns. See lib/sends/scheduled.ts.
//
// Auth is DUAL:
//   - CRON_SECRET Bearer (Vercel Cron, see vercel.json) -> processes ALL orgs'
//     due stages. GET, matching the other crons.
//   - Authenticated session with manager+ (campaigns.drain — the money action)
//     -> processes only the caller's org. POST, for a future "run scheduler now"
//     button. The browser uses its session cookie; CRON_SECRET is never exposed.
// Neither => 401/403.
//
// Firing still obeys every send gate inside the lib: SEND_ENABLED kill-switch
// (whole run no-ops when off), per-stage send_approved, the provider ET send
// window, and resolvable credentials. Nothing sends without SEND_ENABLED on.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches =
    !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  let orgId: string | undefined;
  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    if (!can(auth.role, "campaigns.drain")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    orgId = auth.orgId; // scope the manual run to the caller's org
  }

  const result = await runScheduledSends(db, { orgId });

  // Finalize STRANDED stages — leftovers of a drain interrupted mid-flight (300s
  // cap / crash) that the drain can no longer reach (0 'pending' rows). Marks
  // stale 'sending' rows 'failed' (terminal, NOT re-sent — at-most-once), stamps
  // sent_at, and recomputes cost. Runs every tick, independent of the send gate
  // (it dispatches nothing). See lib/sends/reconcile-stages.ts.
  const reconciled = await reconcileStuckStages(db, { orgId });

  return NextResponse.json({ ...result, reconciled });
}

// Cron (Bearer) hits GET; a manual trigger hits POST. Both share one handler.
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
