import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { pollKeitaroConversions } from "@/lib/keitaro/poll-conversions";
import { can } from "@/lib/permissions";

// Keitaro conversions poll — per-recipient SALE attribution. Vercel Cron hits
// this on a schedule (see vercel.json) with `Authorization: Bearer <CRON_SECRET>`.
// Also callable manually by an operator+ (e.g. the first-run field-check, or to
// force a refresh). Maps each conversion's sub_id_1 → stage_sends.id and stamps
// the sale status/revenue/converted-at. Separate from /api/keitaro/poll (clicks
// aggregate) so the two windows/cadences stay independent.
//
// ?windowDays=N overrides the rolling lookback (default 7).
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

  const result = await pollKeitaroConversions(db, { windowDays });

  // A degraded run (fetch failed) returns 200 with degraded:true so the cron
  // doesn't flap red on a transient Keitaro hiccup. The body includes a small raw
  // `sample` of conversion rows for the first-run field-check (confirm the revenue
  // + conversion-id column names) and `unmatched_samples` when nothing maps back.
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
