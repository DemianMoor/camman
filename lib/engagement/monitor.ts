import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { orgsWithEngineOn } from "@/lib/engagement/settings";
import {
  checkHeartbeats,
  HEARTBEAT_JOBS,
  heartbeatBreaches,
  type DbOrTx,
  type HeartbeatStatus,
} from "@/lib/reporting/cron-heartbeat";

export const ENGAGEMENT_STALE_ALERT = "contact-engagement-stale";
export const ENGAGEMENT_FULL_STALE_ALERT = "contact-engagement-full-stale";

/**
 * Dead-man check for the engagement job, run by ANOTHER job, never by itself:
 * "incremental" from /api/cron/tracking-monitors (hourly), "full" from the
 * 15-minute run. A job that cannot run cannot report itself dead.
 *
 * Silent while no org has the engine on — a switched-off job is not a stale one,
 * which is what lets this PR deploy before the backfill. Once on, the first-run
 * grace in HEARTBEAT_JOBS keeps the deploy itself from paging. Latched per key:
 * one message per transition.
 */
export async function watchEngagementHeartbeat(
  dbc: DbOrTx,
  which: "incremental" | "full",
  opts: { send?: (text: string) => Promise<boolean> } = {},
): Promise<HeartbeatStatus | null> {
  const alertKey = which === "incremental" ? ENGAGEMENT_STALE_ALERT : ENGAGEMENT_FULL_STALE_ALERT;
  if ((await orgsWithEngineOn(dbc)).length === 0) {
    await clearAlert(dbc, { alertKey });
    return null;
  }
  const expectation =
    which === "incremental" ? HEARTBEAT_JOBS.contactEngagement : HEARTBEAT_JOBS.contactEngagementFull;
  const [status] = await checkHeartbeats(dbc, [expectation]);
  const [breach] = heartbeatBreaches([status]);
  if (breach !== undefined) {
    await notifyOnTransition(dbc, {
      alertKey,
      text:
        `⚠️ Contact lifecycle: ${breach} Freeze cadence, suppression and the ` +
        `lifecycle chips read statuses this job maintains, and they go stale ` +
        `while it is down. Check /api/cron/refresh-contact-engagement in Vercel.`,
      send: opts.send,
    });
  } else {
    await clearAlert(dbc, { alertKey });
  }
  return status;
}
