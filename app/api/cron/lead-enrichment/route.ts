import { after, NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import {
  ENRICHMENT_DEADLINE_MS,
  runEnrichmentBatch,
  type EnrichmentTickResult,
} from "@/lib/drip/enrichment";
import {
  isPokeEnabled,
  isPokeRequest,
  requestPoke,
  runLeasedJob,
  type PokeTrigger,
} from "@/lib/drip/poke";
import { can } from "@/lib/permissions";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";

// Drip lead enrichment sweeper (Drip Phase 3). ZERO SENDS.
//
// Drains lead_inbox: normalize → Telnyx lookup through the EXISTING queue →
// landline discarded / mobile-voip-unknown saved as contacts. Nothing here can
// message anyone; the send path is Phase 5.
//
// Auth + lease mirror /api/cron/tells-sweep exactly: CRON_SECRET Bearer for the
// scheduled run, or an authenticated operator+ session for a manual trigger.
//
// ⭐ POKES (0206, lib/drip/poke.ts). A CRON_SECRET request carrying the poke
// header runs the SAME leased function after answering 202 — only the trigger
// differs. Off by default; the cron tick is unchanged either way.
//
// ⚠️ The heartbeat is stamped AFTER the work, so a run that threw does not look
// healthy — and it is checked by a DIFFERENT job (/api/cron/drip-monitors),
// never by this one. A sweeper that reports on its own liveness tells you
// nothing when it is the thing that died. Poked runs never stamp it: pokes must
// not be able to hide a dead cron.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function runSweeper(trigger: PokeTrigger) {
  const out: { last?: EnrichmentTickResult } = {};
  const leased = await runLeasedJob("lead-enrichment", {
    trigger,
    budgetMs: ENRICHMENT_DEADLINE_MS,
    minRunMs: 10_000,
    runOnce: async ({ run, remainingMs }) => {
      const result = await runEnrichmentBatch(new Date(), { deadlineMs: remainingMs });
      out.last = result;
      // One summary line per run: the throughput evidence for card 869ency4b
      // (count, batches, elapsed) without a log-drain or a new table.
      console.log(`[lead-enrichment] ${JSON.stringify({ ...result, trigger, run })}`);
      if (result.lookupsEnqueued > 0) await requestPoke("lookup-worker", "lead-enrichment");
      if (result.processed > 0) await requestPoke("drip-routing", "lead-enrichment");
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
    // Same gate as the other intake-side sweepers.
    if (!can(auth.role, "result_imports.create")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // Manual trigger: run without the lease, as every other manual cron
    // trigger does — rare, human-initiated, and must not silently no-op behind
    // a running cron.
    const result = await runEnrichmentBatch();
    return NextResponse.json(result);
  }

  if (isPokeRequest(req)) {
    if (!(await isPokeEnabled())) {
      return NextResponse.json({ skipped: true, reason: "poke_disabled" });
    }
    after(async () => {
      try {
        await runSweeper("poke");
      } catch (err) {
        console.error("[lead-enrichment] poked run failed (the cron tick still runs):", err);
      }
    });
    return NextResponse.json({ accepted: true }, { status: 202 });
  }

  const { leased, last } = await runSweeper("cron");
  if (!leased.ran) {
    return NextResponse.json({
      skipped: true,
      reason: "prior_run_in_progress",
      skippedCount: leased.skippedCount,
    });
  }
  await recordHeartbeat(db, HEARTBEAT_JOBS.leadEnrichment.job_name);
  return NextResponse.json(last ?? {});
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
