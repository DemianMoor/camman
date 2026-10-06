import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { withCronLease } from "@/lib/cron/lease";
import { can } from "@/lib/permissions";
import { pollTxrOptedOutContacts } from "@/lib/sends/textrequest-contacts-poll";
import { checkTxrWebhookHealth } from "@/lib/sends/textrequest-hooks";
import { pollTxrMessages } from "@/lib/sends/textrequest-messages-poll";
import {
  beginTxrPollRun,
  checkTxrPassAges,
  finishTxrPollRun,
} from "@/lib/sends/textrequest-poll-health";

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
// contacts poll → webhook health → outbound walks, which get only the time left
// before OUTBOUND_DEADLINE_MS. A walk that runs out of time records what it owes
// and reads it first next run (lib/sends/textrequest-messages-poll.ts).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Outbound pages are not started past this many ms into the request (of 60 s). */
const OUTBOUND_DEADLINE_MS = 45_000;

async function step<T>(name: string, fn: () => Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    console.error(`[textrequest-poll] step ${name} threw:`, e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function run(startedAt: number, orgId: string | undefined, cron: boolean) {
  const runStart = cron ? await beginTxrPollRun(db) : null;
  const inbound = await step("inbound", () => pollTxrMessages(db, { orgId, directions: ["R"] }));
  const contacts = await step("contacts", () => pollTxrOptedOutContacts(db, { orgId }));
  const health = await step("health", () => checkTxrWebhookHealth(db, { orgId }));
  const outbound = await step("outbound", () =>
    pollTxrMessages(db, { orgId, directions: ["S"], deadlineAt: startedAt + OUTBOUND_DEADLINE_MS }),
  );
  const dashboards = [
    ...new Set(
      [inbound, outbound].flatMap((r) => (r.ok ? r.result.walks.map((w) => w.dashboard_id) : [])),
    ),
  ];
  const passes = cron ? await step("pass-check", () => checkTxrPassAges(db, dashboards)) : null;
  const finish = cron ? await finishTxrPollRun(db) : null;
  // ONE line per run, so the run history is countable from the request logs
  // (the 24 h verification counts these: every step must say ok).
  console.log(
    JSON.stringify({
      txr_poll_run: {
        ms: Date.now() - startedAt,
        inbound: inbound.ok,
        contacts: contacts.ok,
        health: health.ok,
        outbound: outbound.ok,
        outbound_complete: outbound.ok ? outbound.result.outbound_gaps.length === 0 : false,
        gaps: outbound.ok ? outbound.result.outbound_gaps.length : null,
        captured: outbound.ok ? outbound.result.captured : null,
      },
    }),
  );
  return { run: runStart, inbound, contacts, health, outbound, passes, finish };
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
