import { sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { refreshFreshCounts } from "@/lib/audience/fresh-counts";

// Refreshes audience_fresh_counts for every org (ClickUp 869evpmbz).
//
// ⚠️ OFF THE SEND PATH. Reads campaign_audience_pool, campaigns, contacts,
// opt_outs and the contact-group junction. It never touches stage_sends,
// materialize or the drain, and it writes exactly one row per org.
//
// Every 30 minutes, not every minute like refresh-contact-stats: the query is
// ~13.5s against production (671K eligible contacts, 2.0M pool rows), so a
// tighter schedule would spend a meaningful fraction of wall-clock recomputing a
// number that answers "what should I load today". maxDuration 60 gives roughly
// 4x headroom over the measured cost; `duration_ms` is persisted so the trend is
// visible before it becomes a problem.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgRows = (await db.execute(
    sql`SELECT id AS org_id FROM public.organizations`,
  )) as unknown as { org_id: string }[];

  const results: { org_id: string; duration_ms: number; error?: string }[] = [];
  for (const { org_id } of orgRows) {
    // Per-org try/catch: one org whose data trips a timeout must not stop the
    // rest from refreshing. The row simply keeps its previous computed_at, and
    // the endpoint reports staleness honestly rather than serving nothing.
    try {
      const { durationMs } = await refreshFreshCounts(org_id);
      results.push({ org_id, duration_ms: durationMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[fresh-counts] refresh failed", { org_id, error: message });
      results.push({ org_id, duration_ms: 0, error: message });
    }
  }

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
