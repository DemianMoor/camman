import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { pollKeitaro } from "@/lib/keitaro/poll";
import { can } from "@/lib/permissions";

// Keitaro 5-minute poll. Vercel Cron hits this on a schedule (see vercel.json)
// with `Authorization: Bearer <CRON_SECRET>`. Also callable manually by an
// operator+ (e.g. to verify the live connection or force a refresh) — the
// manual path resolves the caller's org only for the permission check; the
// poll itself maps results to orgs by sub_id_3 either way.
//
// ?windowDays=N overrides the rolling lookback window (default 3).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches =
    !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    // Triggering a results sync is an import-shaped action (operator+).
    if (!can(auth.role, "result_imports.create")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const windowRaw = Number(req.nextUrl.searchParams.get("windowDays"));
  const windowDays =
    Number.isFinite(windowRaw) && windowRaw > 0
      ? Math.min(30, Math.floor(windowRaw))
      : undefined;

  const result = await pollKeitaro(db, { windowDays });

  // A degraded run (fetch failed) returns 200 with degraded:true so the cron
  // doesn't flap red on a transient Keitaro hiccup — it logs and retries next
  // cycle. The body surfaces everything needed to debug (incl. unmatched
  // sub_id_3 samples when nothing maps back to a CamMan stage).
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
