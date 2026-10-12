import { after, NextResponse, type NextRequest } from "next/server";

import { isPokeEnabled, isPokeRequest, requestPoke, runLeasedJob } from "@/lib/drip/poke";
import { runLookupWorker } from "@/lib/telnyx/worker";

// Cron-triggered Telnyx number-lookup drain. Vercel Cron hits this every 2 minutes
// (see vercel.json) with `Authorization: Bearer <CRON_SECRET>`. A single-runner
// lease inside runLookupWorker means overlapping invocations are a no-op, so a slow
// run can't multiply the effective Telnyx rate.
//
// ⭐ POKES (0206, lib/drip/poke.ts). The lookup stays a QUEUE worker: a poke only
// runs this same runLookupWorker sooner — same lease, same rps pacing, same daily
// cap and balance guards, and no extra Telnyx call (each queued number is looked
// up once either way). A poked run additionally sits under the 'lookup-worker'
// cron_locks lease so pokes coalesce; runLookupWorker's own lease still decides
// who may call Telnyx.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isPokeRequest(req)) {
    if (!(await isPokeEnabled())) {
      return NextResponse.json({ skipped: true, reason: "poke_disabled" });
    }
    after(async () => {
      try {
        await runLeasedJob("lookup-worker", {
          trigger: "poke",
          // Covers maxDuration: one runLookupWorker is ≤ 250 s, and a re-run
          // starts only within the first 30 s.
          ttlMs: 330_000,
          budgetMs: 30_000,
          minRunMs: 0,
          runOnce: async ({ run }) => {
            const result = await runLookupWorker();
            console.log(`[lookup-worker] ${JSON.stringify({ ...result, trigger: "poke", run })}`);
            if (result.processed > 0) await requestPoke("lead-enrichment", "lookup-worker");
          },
        });
      } catch (err) {
        console.error("[lookup-worker] poked run failed (the cron tick still runs):", err);
      }
    });
    return NextResponse.json({ accepted: true }, { status: 202 });
  }

  const result = await runLookupWorker();
  // Finished lookups are what the enrichment sweeper's second pass waits for.
  if (result.processed > 0) await requestPoke("lead-enrichment", "lookup-worker");
  // Always 200 so the cron doesn't flap red on a benign no-lease/paused/no-work exit.
  return NextResponse.json(result);
}
