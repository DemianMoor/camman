import { after, NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { isPokeEnabled, isPokeRequest, runLeasedJob } from "@/lib/drip/poke";
import { can } from "@/lib/permissions";
import { reconcileStuckStages } from "@/lib/sends/reconcile-stages";
import { runScheduledSends } from "@/lib/sends/scheduled";
import { refreshDripStageCosts } from "@/lib/stages/total-cost";

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
//
// ⭐ DRIP POKES (0206, lib/drip/poke.ts). A CRON_SECRET request with the poke
// header runs a DRIP-ONLY drain (runScheduledSends dripOnly: no Phase A, drip
// stages only) under the 'drip-drain' lease, after answering 202. It skips the
// housekeeping below (stuck-stage reconcile, drip cost refresh) — neither is on
// the send path, and both stay on this route's cron tick. Regular campaigns are
// never drained by a poke, so their per-run budget and send rate are exactly as
// before. The 5-minute cron path below is unchanged.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function runPokedDripDrain(): Promise<void> {
  await runLeasedJob("drip-drain", {
    trigger: "poke",
    // Covers maxDuration: Phase B stops at 240 s from its own start, and a
    // re-run starts only within the first 30 s.
    ttlMs: 330_000,
    budgetMs: 30_000,
    minRunMs: 0,
    runOnce: async ({ run }) => {
      const result = await runScheduledSends(db, { dripOnly: true });
      console.log(`[drip-drain] ${JSON.stringify({ ...result, trigger: "poke", run })}`);
      // The drip number is shared with regular campaigns: when the 5-minute
      // drain holds its per-phone lease, look again shortly rather than leave
      // the queued rows for the next tick.
      return { again: result.phone_lease_skipped > 0 };
    },
  });
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches =
    !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  if (bearerMatches && isPokeRequest(req)) {
    if (!(await isPokeEnabled())) {
      return NextResponse.json({ skipped: true, reason: "poke_disabled" });
    }
    after(async () => {
      try {
        await runPokedDripDrain();
      } catch (err) {
        console.error("[drip-drain] poked run failed (the cron tick still runs):", err);
      }
    });
    return NextResponse.json({ accepted: true }, { status: 202 });
  }

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

  // Drip stages send for weeks, and nothing in the drain writes total_cost, so
  // refresh the ones that sent recently. Dispatches nothing.
  const dripCostsRefreshed = await refreshDripStageCosts(db, { orgId });

  return NextResponse.json({ ...result, reconciled, dripCostsRefreshed });
}

// Cron (Bearer) hits GET; a manual trigger hits POST. Both share one handler.
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
