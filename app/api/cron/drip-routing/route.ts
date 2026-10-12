import { after, NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import {
  isPokeEnabled,
  isPokeRequest,
  requestPoke,
  runLeasedJob,
  type PokeTrigger,
} from "@/lib/drip/poke";
import { DRIP_ROUTING_DEADLINE_MS, runDripRoutingBatch, type RoutingResult } from "@/lib/drip/routing";
import { can } from "@/lib/permissions";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";

// Drip routing worker (Drip Phase 4). ZERO SENDS.
//
// Assigns processed leads to exactly one drip campaign. Nothing here can message
// anyone — the scheduler that turns a journey into a send is Phase 5.
//
// Gated on drip POSTURE: with org_settings.drip_enabled false (every org today)
// runDripRoutingBatch returns immediately having read one row. So this cron can
// ship live and inert, which is the point of the flag.
//
// ⭐ POKES (0206, lib/drip/poke.ts): a poked run is runDripRoutingBatch under the
// same 'drip-routing' lease — the identical evaluator, freshness and carry rules.
//
// ⚠️ Heartbeat stamped AFTER the work, and checked by a DIFFERENT job
// (/api/cron/drip-monitors), never by this one. Cron runs only.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function runRouting(trigger: PokeTrigger) {
  const out: { last?: RoutingResult } = {};
  const leased = await runLeasedJob("drip-routing", {
    trigger,
    budgetMs: DRIP_ROUTING_DEADLINE_MS,
    minRunMs: 10_000,
    runOnce: async ({ run, remainingMs }) => {
      const result = await runDripRoutingBatch(new Date(), { deadlineMs: remainingMs });
      out.last = result;
      // One summary line per run: the throughput evidence for card 869ency4b
      // (count, batches, elapsed) without a log-drain or a new table.
      console.log(`[drip-routing] ${JSON.stringify({ ...result, trigger, run })}`);
      if (result.routed > 0) await requestPoke("drip-scheduler", "drip-routing");
    },
  });
  return { leased, last: out.last };
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    if (!can(auth.role, "campaigns.update")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json(await runDripRoutingBatch());
  }

  if (isPokeRequest(req)) {
    if (!(await isPokeEnabled())) {
      return NextResponse.json({ skipped: true, reason: "poke_disabled" });
    }
    after(async () => {
      try {
        await runRouting("poke");
      } catch (err) {
        console.error("[drip-routing] poked run failed (the cron tick still runs):", err);
      }
    });
    return NextResponse.json({ accepted: true }, { status: 202 });
  }

  const { leased, last } = await runRouting("cron");
  if (!leased.ran) {
    return NextResponse.json({
      skipped: true, reason: "prior_run_in_progress", skippedCount: leased.skippedCount,
    });
  }
  await recordHeartbeat(db, HEARTBEAT_JOBS.dripRouting.job_name);
  return NextResponse.json(last ?? {});
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
