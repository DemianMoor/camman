import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { orgsWithEngineOn } from "@/lib/engagement/settings";
import {
  checkHeartbeats,
  HEARTBEAT_JOBS,
  heartbeatBreaches,
  type DbOrTx,
  type HeartbeatExpectation,
  type HeartbeatStatus,
} from "@/lib/reporting/cron-heartbeat";

export const ENGAGEMENT_STALE_ALERT = "contact-engagement-stale";
export const ENGAGEMENT_FULL_STALE_ALERT = "contact-engagement-full-stale";
export const ENGAGEMENT_GROUP_ROLLUP_STALE_ALERT = "contact-engagement-group-rollup-stale";
export const ENGAGEMENT_DAY_ROLLUP_STALE_ALERT = "contact-engagement-day-rollup-stale";

const ROUTE_HINT = "Check /api/cron/refresh-contact-engagement in Vercel.";
const STATUS_IMPACT =
  "Freeze cadence, suppression and the lifecycle chips read statuses this job " +
  "maintains, and they go stale while it is down.";
// A rollup is read-side only: the recount has its own heartbeat, so a stale
// rollup means a stale report, never stale statuses. Say so, or the alert reads
// as a send-path problem.
const ROLLUP_IMPACT = "Contact statuses are unaffected (the recount has its own heartbeat);";

type Step = { expectation: HeartbeatExpectation; alertKey: string; text: (breach: string) => string };

// Each watcher checks a recount and the rollup that runs after it in the same
// route. The recount comes FIRST: its status is what the function returns.
const STEPS: Record<"incremental" | "full", Step[]> = {
  incremental: [
    {
      expectation: HEARTBEAT_JOBS.contactEngagement,
      alertKey: ENGAGEMENT_STALE_ALERT,
      text: (b) => `⚠️ Contact lifecycle: ${b} ${STATUS_IMPACT} ${ROUTE_HINT}`,
    },
    {
      expectation: HEARTBEAT_JOBS.contactEngagementGroupRollup,
      alertKey: ENGAGEMENT_GROUP_ROLLUP_STALE_ALERT,
      text: (b) =>
        `⚠️ Contact lifecycle: ${b} ${ROLLUP_IMPACT} the Group × Lifecycle report shows old numbers until it runs. ${ROUTE_HINT}`,
    },
  ],
  full: [
    {
      expectation: HEARTBEAT_JOBS.contactEngagementFull,
      alertKey: ENGAGEMENT_FULL_STALE_ALERT,
      text: (b) => `⚠️ Contact lifecycle: ${b} ${STATUS_IMPACT} ${ROUTE_HINT}`,
    },
    {
      expectation: HEARTBEAT_JOBS.contactEngagementDayRollup,
      alertKey: ENGAGEMENT_DAY_ROLLUP_STALE_ALERT,
      text: (b) =>
        `⚠️ Contact lifecycle: ${b} ${ROLLUP_IMPACT} the Lifecycle day report misses recent days until it runs. ${ROUTE_HINT}`,
    },
  ],
};

/**
 * Dead-man check for the engagement job, run by ANOTHER job, never by itself:
 * "incremental" from /api/cron/tracking-monitors (hourly) — the 15-min recount
 * and the Group x Lifecycle rollup; "full" from the 15-minute run — the nightly
 * recount and the Lifecycle day rollup. A job that cannot run cannot report
 * itself dead. Each step has its own heartbeat and alert key, so the message
 * names the step that is stale.
 *
 * Silent while no org has the engine on — a switched-off job is not a stale one,
 * which is what lets this PR deploy before the backfill. Once on, the first-run
 * grace in HEARTBEAT_JOBS keeps the deploy itself from paging. Latched per key:
 * one message per transition. Returns the RECOUNT's status.
 */
export async function watchEngagementHeartbeat(
  dbc: DbOrTx,
  which: "incremental" | "full",
  opts: { send?: (text: string) => Promise<boolean> } = {},
): Promise<HeartbeatStatus | null> {
  const steps = STEPS[which];
  if ((await orgsWithEngineOn(dbc)).length === 0) {
    for (const s of steps) await clearAlert(dbc, { alertKey: s.alertKey });
    return null;
  }
  const statuses = await checkHeartbeats(dbc, steps.map((s) => s.expectation));
  for (const [i, s] of steps.entries()) {
    const [breach] = heartbeatBreaches([statuses[i]]);
    if (breach !== undefined) {
      await notifyOnTransition(dbc, { alertKey: s.alertKey, text: s.text(breach), send: opts.send });
    } else {
      await clearAlert(dbc, { alertKey: s.alertKey });
    }
  }
  return statuses[0];
}
