import { sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { refreshAudiencePools } from "@/lib/audience/pools";
import { withCronLease } from "@/lib/cron/lease";

// Refreshes the audience_pools rollup (operator_rollups) for every org — the data
// behind GET /api/audience/pools.
//
// ⚠️ READS stage_sends: one org-wide aggregate per org, measured 40.2s on prod
// (2026-09-14, default work_mem) and 41.0 s / 2.02 GB per run on live ticks
// (2026-09-23). Read-only against the send tables; writes one operator_rollups
// row per org. At :29 it never coincides with refresh-fresh-counts (:11/:41) or
// the */5 jobs.
//
// HOURLY since 2026-09-23, cut from `29,59 * * * *`. At 48 runs/day this was the
// platform's largest scheduled reader (~97 GB/day). These are planning counts,
// an hour stale changes no decision made from them, and nothing on the send,
// preflight, kickoff or compliance path reads them — see the note in
// app/api/audience/pools/route.ts.
//
// maxDuration 300 because the cost grows with send volume; the lease TTL sits
// past it so a slow run can never overlap the next tick.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LEASE_MS = 6 * 60 * 1000;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await withCronLease(
    "refresh-audience-pools",
    async () => {
      const orgRows = (await db.execute(
        sql`SELECT id AS org_id FROM public.organizations`,
      )) as unknown as { org_id: string }[];
      const results: { org_id: string; duration_ms: number; error?: string }[] = [];
      for (const { org_id } of orgRows) {
        // One org's failure must not stop the rest; its row keeps the previous
        // computed_at and the endpoint reports the staleness.
        try {
          const { durationMs } = await refreshAudiencePools(org_id);
          results.push({ org_id, duration_ms: durationMs });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[audience-pools] refresh failed", { org_id, error: message });
          results.push({ org_id, duration_ms: 0, error: message });
        }
      }
      return results;
    },
    LEASE_MS,
  );
  if (!outcome.ran) {
    // Overlap with a still-running refresh — expected backpressure.
    return NextResponse.json({ ok: true, skipped: true });
  }

  const results = outcome.result;
  return NextResponse.json({
    refreshed: results.filter((r) => !r.error).length,
    failed: results.filter((r) => r.error).length,
    results,
    ts: new Date().toISOString(),
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
