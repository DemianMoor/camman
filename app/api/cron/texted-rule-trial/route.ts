import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { requireApiMembership } from "@/lib/api/helpers";
import { orgsWithEngineOn } from "@/lib/engagement/settings";
import { can } from "@/lib/permissions";
import {
  nextTrialState,
  readTrialState,
  runTextedRuleTrial,
  trialMessage,
  writeTrialState,
} from "@/lib/segments/texted-rule-trial";

// Nightly trial of the "Texted in the last…" segment rule (Task 3 T5):
// served (fact) vs the sends themselves (direct), manual-send gaps, and the
// old-vs-new counts of the segments the owner will switch. 14 consecutive
// clean nights before the first switch. See lib/segments/texted-rule-trial.ts.
//
// Scheduled 05:20 UTC (vercel.json): the quiet window, after the 05:00
// offer-group refresh. Each org's comparison runs in ONE read-only REPEATABLE
// READ transaction, so a send landing mid-run cannot read as drift. Only the
// scheduler (CRON_SECRET) records the streak and posts to Telegram; a signed-in
// human gets the report for their own org, with nothing written or sent.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  let orgs: string[];
  if (bearerMatches) {
    orgs = await orgsWithEngineOn(db);
  } else {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    if (!can(auth.role, "campaigns.view")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    orgs = [auth.orgId];
  }

  const results = [];
  for (const orgId of orgs) {
    const t0 = Date.now();
    const report = await db.transaction(
      (tx) => runTextedRuleTrial(tx, orgId),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    if (!bearerMatches) {
      results.push({ report, state: await readTrialState(db, orgId) });
      continue;
    }
    const state = nextTrialState(await readTrialState(db, orgId), report);
    await writeTrialState(db, orgId, state, Date.now() - t0);
    const text = trialMessage(report, state);
    if (text) await notifyTelegram(text);
    results.push({ org_id: orgId, drift: report.drift, streak: state.streak, gaps: report.manual_gaps.length });
  }
  return NextResponse.json({ ok: true, results });
}

export const GET = handle;
export const POST = handle;
