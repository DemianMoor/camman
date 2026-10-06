import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { withCronLease } from "@/lib/cron/lease";
import { can } from "@/lib/permissions";
import { defaultTxrPollSteps, runTxrPollTick } from "@/lib/sends/textrequest-poll-run";

// Text Request poll tick (Phases 3b + 4) — three jobs behind one cron entry:
//   1. messages poll: DLR reconciliation backstop for the per-message
//      status_callback, AND the inbound-STOP backstop for the msg_received hook
//      (lib/sends/textrequest-messages-poll.ts)
//   2. contacts poll: opt-out backstop for the contact_updated hook
//      (lib/sends/textrequest-contacts-poll.ts)
//   3. webhook health: reactivate any account hook Text Request disconnected
//      after 10 consecutive non-2XX responses (lib/sends/textrequest-hooks.ts)
//
// One route rather than three because they share the same credential/dashboard
// resolution and the same cadence, and a Vercel cron entry is a scarce resource.
// Auth + lease mirror /api/cron/ahoi-cdr-poll exactly: CRON_SECRET Bearer (Vercel
// Cron, all orgs) or an authenticated operator+ session (manual trigger, scoped
// to the caller's org).
//
// Every step runs even if an earlier one errored (each reports its own failure
// and alerts internally) — the opt-out paths are compliance-critical, so one
// dashboard's outage must not skip the rest of the work.
//
// ⚠️ ORDER AND DEADLINE (ClickUp 869fcqhcu). Until 2026-10-06 the messages poll
// ran first and unbudgeted; on the night of 2026-10-05 it hit the 60 s limit on
// 25 runs in a row, so the contacts opt-out backstop and webhook health — which
// ran after it — did not run at all. Now: inbound walks (STOP backstop) →
// contacts poll → webhook health → outbound walks. Inbound gets 20 s, outbound
// the time left before 45 s (lib/sends/textrequest-poll-run.ts). A walk that
// runs out of time records what it owes and reads it first next run
// (lib/sends/textrequest-messages-poll.ts) — cron runs only.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function run(startedAt: number, orgId: string | undefined, cron: boolean) {
  return runTxrPollTick(defaultTxrPollSteps(db, { orgId, stateful: cron }), { cron, startedAt });
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
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
    const leased = await withCronLease("textrequest-poll", () => run(startedAt, orgId, true));
    if (!leased.ran) {
      return NextResponse.json({
        skipped: true,
        reason: "prior_run_in_progress",
        skippedCount: leased.skippedCount,
      });
    }
    return NextResponse.json(leased.result);
  }

  return NextResponse.json(await run(startedAt, orgId, false));
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
