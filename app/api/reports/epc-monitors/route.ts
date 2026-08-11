import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import {
  HEARTBEAT_JOBS,
  checkHeartbeats,
  heartbeatBreaches,
  recordHeartbeat,
} from "@/lib/reporting/cron-heartbeat";
import { runEpcMonitors } from "@/lib/reporting/epc-monitors";
import { notifyTelegram } from "@/lib/alerts/telegram";

// Weekly EPC integrity monitors (see lib/reporting/epc-monitors.ts):
//   1. human share of taps, monthly
//   2. conversion rate of EXCLUDED clickers  — alert > 0.1%
//   3. Rule F rescue count                   — alert > 2.5x the baseline of 8
//   + precedence row-5 probe                 — alert on any violation
//
// The platform's entire EPC denominator rests on one signal (a click scoring
// 'human', which rests mostly on the datacenter-ASN check covering 91% of taps).
// The 2026-08-11 misclassification went unnoticed for two months. These fire on
// breach so the next one is caught by the system rather than by someone asking
// the right question.
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const preferredRegion = "fra1";

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches =
    !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    if (!can(auth.role, "campaigns.view")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const report = await runEpcMonitors(db);

  // Dead-man check: this job watches the DAILY rebuild, never itself — a dead
  // job cannot report itself dead. The rebuild returns the favour.
  const heartbeats = await checkHeartbeats(db, [HEARTBEAT_JOBS.countedClickersFull]);
  const allBreaches = [...report.breaches, ...heartbeatBreaches(heartbeats)];

  // Alert only on breach — a weekly all-clear message trains people to ignore it.
  if (bearerMatches && allBreaches.length > 0) {
    const lines = [
      "⚠️ *EPC integrity monitor*",
      "",
      ...allBreaches.map((b) => `• ${b}`),
      "",
      `Rule F rescues: ${report.rule_f.rescues} (baseline ${report.rule_f.baseline})`,
      `Excluded-clicker conversion: ${report.excluded_conversion.conv_pct}%`,
      `Row-5 violations: ${report.row5.reached_without_click}`,
    ];
    try {
      await notifyTelegram(lines.join("\n"));
    } catch (err) {
      // Never let alert delivery failure fail the job — the body still carries
      // the findings and the next run re-evaluates from scratch.
      console.error("[epc-monitors] telegram delivery failed", err);
    }
  }

  // Stamp AFTER the work, so a run that threw does not look healthy.
  if (bearerMatches) await recordHeartbeat(db, HEARTBEAT_JOBS.epcMonitors.job_name);

  return NextResponse.json({ ...report, heartbeats, breaches: allBreaches });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
