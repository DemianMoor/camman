import { after, NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { leadToSendLatency } from "@/lib/drip/lead-latency";
import {
  isPokeEnabled,
  isPokeRequest,
  requestPoke,
  runLeasedJob,
  type PokeTrigger,
} from "@/lib/drip/poke";
import { runDripSchedulerBatch, type SchedulerResult } from "@/lib/drip/scheduler";
import { can } from "@/lib/permissions";
import { checkHeartbeats, HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";

// Drip scheduler (Drip Phase 5).
//
// Turns due journeys into PENDING stage_sends rows. It does not send anything —
// the existing drain does, unmodified (G1).
//
// ⚠️ Gated on drip POSTURE. With org_settings.drip_enabled false (its production
// value) runDripSchedulerBatch does only the posture read plus one cheap
// clearIneligibleHourAssignments UPDATE (partial index, usually 0 rows) and returns, so this ships live and
// effectively inert. That is the point of the flag.
//
// ⚠️ It also CLOSES THE P3 GAP: drip-monitors watches the sweeper and the
// routing worker but was itself unwatched. This job checks its heartbeat, giving
// the same mutual dead-man arrangement tells-sweep/tells-monitors uses — a
// watcher nobody watches is silent in exactly the case that matters.
//
// ⭐ POKES (0206, lib/drip/poke.ts): a poked run is runDripSchedulerBatch under
// the same 'drip-scheduler' lease — the identical mint, render, opt-out gate and
// stop controls. Heartbeats (stamp + check) and the per-minute latency line stay
// on the cron run.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function runScheduler(trigger: PokeTrigger) {
  const out: { last?: SchedulerResult & { heartbeats?: unknown } } = {};
  const leased = await runLeasedJob("drip-scheduler", {
    trigger,
    // No deadline inside the batch (200 leads ≈ 9 s on prod), so a re-run only
    // starts while 15 s of the 45 s budget remain.
    budgetMs: 45_000,
    minRunMs: 15_000,
    runOnce: async ({ run }) => {
      const result = await runDripSchedulerBatch();
      // The watcher-of-the-watcher half — once per cron invocation.
      const heartbeats =
        trigger === "cron" && run === 1 ? await checkHeartbeats(db, [HEARTBEAT_JOBS.dripMonitors]) : undefined;
      out.last = { ...result, heartbeats };
      if (result.postureOn) console.log(`[drip-scheduler] ${JSON.stringify({ ...result, trigger, run })}`);
      if (result.inserted > 0) await requestPoke("drip-drain", "drip-scheduler");
    },
  });
  return { leased, last: out.last };
}

// Per-minute evidence for the poke chain: median of every hop for the leads
// whose first message went out in the previous whole minute. Cron runs only,
// so it is exactly one line a minute. Best-effort: never fails the tick.
async function logMinuteLatency(now: Date): Promise<void> {
  try {
    const to = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const from = new Date(to.getTime() - 60_000);
    const orgs = (await db.execute(sql`
      SELECT org_id FROM org_settings WHERE drip_enabled = true
    `)) as unknown as { org_id: string }[];
    for (const { org_id } of orgs) {
      const l = await leadToSendLatency(db, { orgId: org_id, from, to });
      if (l.n === 0) continue;
      console.log(`[lead-latency] ${JSON.stringify({ org: org_id, minute: from.toISOString(), ...l })}`);
    }
  } catch (err) {
    console.error("[lead-latency] failed (swallowed):", err);
  }
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
    return NextResponse.json(await runDripSchedulerBatch());
  }

  if (isPokeRequest(req)) {
    if (!(await isPokeEnabled())) {
      return NextResponse.json({ skipped: true, reason: "poke_disabled" });
    }
    after(async () => {
      try {
        await runScheduler("poke");
      } catch (err) {
        console.error("[drip-scheduler] poked run failed (the cron tick still runs):", err);
      }
    });
    return NextResponse.json({ accepted: true }, { status: 202 });
  }

  const { leased, last } = await runScheduler("cron");
  if (!leased.ran) {
    return NextResponse.json({
      skipped: true, reason: "prior_run_in_progress", skippedCount: leased.skippedCount,
    });
  }
  await recordHeartbeat(db, HEARTBEAT_JOBS.dripScheduler.job_name);
  if (last?.postureOn) await logMinuteLatency(new Date());
  return NextResponse.json(last ?? {});
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
