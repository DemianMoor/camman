import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { withCronLease } from "@/lib/cron/lease";
import { can } from "@/lib/permissions";
import { pollTxrOptedOutContacts } from "@/lib/sends/textrequest-contacts-poll";
import { checkTxrWebhookHealth } from "@/lib/sends/textrequest-hooks";
import { pollTxrMessages } from "@/lib/sends/textrequest-messages-poll";

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
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(orgId?: string) {
  const poll = await pollTxrMessages(db, { orgId });
  const contacts = await pollTxrOptedOutContacts(db, { orgId });
  const health = await checkTxrWebhookHealth(db, { orgId });
  return { poll, contacts, health };
}

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
    const leased = await withCronLease("textrequest-poll", () => run(orgId));
    if (!leased.ran) {
      return NextResponse.json({
        skipped: true,
        reason: "prior_run_in_progress",
        skippedCount: leased.skippedCount,
      });
    }
    return NextResponse.json(leased.result);
  }

  return NextResponse.json(await run(orgId));
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
