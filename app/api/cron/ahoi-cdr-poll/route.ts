import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { withCronLease } from "@/lib/cron/lease";
import { can } from "@/lib/permissions";
import { pollAhoiCdr } from "@/lib/sends/ahoi-cdr-poll";

// Ahoi CDR poll — inbound capture reconciliation backstop (Section 3 Task 7).
// Lives under the existing /api/cron/ namespace alongside send-scheduled,
// telegram-report, lookup-worker, carrier-triage. Cron schedule is staggered
// (13,28,43,58) so it doesn't pile on the top-of-hour with the other pollers.
// Auth mirrors /api/opt-outs/poll and /api/keitaro/poll: CRON_SECRET Bearer
// (Vercel Cron, all orgs) or an authenticated operator+ session (manual
// trigger, scoped to the caller's org) — "triggering a capture sync" is
// import-shaped, same permission keitaro/poll uses.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  let orgId: string | undefined;
  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    if (!can(auth.role, "result_imports.create")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    orgId = auth.orgId;
  }

  if (bearerMatches) {
    const leased = await withCronLease("ahoi-cdr-poll", () => pollAhoiCdr(db, { orgId }));
    if (!leased.ran) {
      return NextResponse.json({ skipped: true, reason: "prior_run_in_progress", skippedCount: leased.skippedCount });
    }
    return NextResponse.json(leased.result);
  }

  const result = await pollAhoiCdr(db, { orgId });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
