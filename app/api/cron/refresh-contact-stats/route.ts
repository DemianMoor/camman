import { sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { refreshContactOrgStats } from "@/lib/contact-stats";

// W2 Task 1: 1-minute cron that refreshes contact_org_stats for every org.
// Performs a full recompute (scalar counts + carrier_breakdown JSONB) once per
// minute in the background so every page reads a pre-computed row instead of
// triggering a live GROUP BY over 750K+ rows. Also serves as the initial backfill
// after migration 0145 applies.
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

  let refreshed = 0;
  for (const { org_id } of orgRows) {
    await refreshContactOrgStats(db, org_id);
    refreshed++;
  }

  return NextResponse.json({ refreshed, ts: new Date().toISOString() });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
