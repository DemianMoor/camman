import { sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { withCronLease } from "@/lib/cron/lease";
import { refreshCreativeCtr } from "@/lib/creatives/ctr-rollup";
import { refreshCreativeLifetime } from "@/lib/reporting/creative-lifetime";

// Refreshes two per-org creative snapshots in operator_rollups:
//   - performance_creative_lifetime: the all-time creative × offer rows behind
//     GET /api/reports/performance dimension=creative range=lifetime. Two
//     all-time stage-metrics passes per org, one per attribution basis (13.7s +
//     12.0s measured on prod 2026-09-14).
//   - creative_ctr: per-creative sends + counted clickers for 7d / 30d / all
//     time, the CTR on /creatives and in the stage creative picker
//     (lib/creatives/ctr-rollup.ts). One stage_sends pass (11.5s measured on
//     prod 2026-09-14).
//
// Read-only against the report tables; writes one operator_rollups row per org
// per key. Hourly at :14 — off every */5 minute and off refresh-fresh-counts
// (:11/:41) and refresh-audience-pools (:29/:59).
//
// maxDuration 300 because the cost grows with history; the lease TTL sits past
// it so a slow run can never overlap the next tick.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LEASE_MS = 6 * 60 * 1000;

type OrgResult = {
  org_id: string;
  duration_ms: number;
  error?: string;
  ctr_duration_ms: number;
  ctr_error?: string;
};

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await withCronLease(
    "refresh-creative-lifetime",
    async () => {
      const orgRows = (await db.execute(
        sql`SELECT id AS org_id FROM public.organizations`,
      )) as unknown as { org_id: string }[];
      const results: OrgResult[] = [];
      for (const { org_id } of orgRows) {
        // One org's failure must not stop the rest, and one snapshot's failure
        // must not stop the other; a failed row keeps its previous computed_at.
        const result: OrgResult = { org_id, duration_ms: 0, ctr_duration_ms: 0 };
        try {
          result.duration_ms = (await refreshCreativeLifetime(org_id)).durationMs;
        } catch (err) {
          result.error = err instanceof Error ? err.message : String(err);
          console.error("[creative-lifetime] refresh failed", { org_id, error: result.error });
        }
        try {
          result.ctr_duration_ms = (await refreshCreativeCtr(org_id)).durationMs;
        } catch (err) {
          result.ctr_error = err instanceof Error ? err.message : String(err);
          console.error("[creative-ctr] refresh failed", { org_id, error: result.ctr_error });
        }
        results.push(result);
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
    refreshed: results.filter((r) => !r.error && !r.ctr_error).length,
    failed: results.filter((r) => r.error || r.ctr_error).length,
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
