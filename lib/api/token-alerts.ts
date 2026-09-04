import "server-only";

import { db } from "@/db/client";
import { notifyOnTransition } from "@/lib/alerts/alert-state";

// Telegram alerts for API-token abuse (ClickUp 869evpmbz).
//
// ⚠️ THE HOUR IS IN THE ALERT KEY, AND THAT IS THE WHOLE RATE-LIMITING MECHANISM
// for the alerts themselves. notifyOnTransition() sends on the transition into
// `firing` and then stays quiet while the condition persists, so a key that
// changes every hour gives exactly "at most one message per token per hour"
// without a second piece of state to keep. A stable key would alert once and
// then go silent for as long as the probing continued — the wrong direction.
//
// ⚠️ NOT notifyTelegram() DIRECTLY. These fire on a per-request path, so a bare
// send would page on every single denial. notifyOnTransition also RETRIES until
// delivery is confirmed, which is the property lib/alerts/alert-state.ts exists
// for: alerting must latch on DELIVERY, not on detection, or a send that fails
// on the crossing request is lost permanently.
//
// Both helpers are best-effort by contract — notifyOnTransition never throws —
// so a Telegram outage can never turn a 403 into a 500.

/** Start of the current UTC hour, as a stable string for the alert key. */
function hourKey(now: Date): string {
  return now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

/**
 * Someone is probing routes this token may not reach.
 *
 * `count` is the running hourly denial tally from recordTokenDenial(), which
 * keeps counting PAST the threshold on purpose — the message reports the real
 * figure rather than restating the threshold.
 */
export async function alertDenialBurst(opts: {
  orgId: string;
  tokenId: string;
  tokenName: string;
  memberLabel: string;
  count: number;
  lastRoute: string;
  lastMethod: string;
  now?: Date;
}): Promise<void> {
  const now = opts.now ?? new Date();
  await notifyOnTransition(db, {
    alertKey: `api-token-denials:${opts.tokenId}:${hourKey(now)}`,
    orgId: opts.orgId,
    text:
      `🚫 API token denials\n` +
      `Token: ${opts.tokenName} (${opts.memberLabel})\n` +
      `${opts.count} denied request${opts.count === 1 ? "" : "s"} this hour.\n` +
      `Most recent: ${opts.lastMethod} ${opts.lastRoute}\n` +
      `Revoke it in Settings → Users if this was not expected.`,
  });
}

/** The token burned its hourly budget. */
export async function alertRateLimitTrip(opts: {
  orgId: string;
  tokenId: string;
  tokenName: string;
  memberLabel: string;
  limit: number;
  now?: Date;
}): Promise<void> {
  const now = opts.now ?? new Date();
  await notifyOnTransition(db, {
    alertKey: `api-token-ratelimit:${opts.tokenId}:${hourKey(now)}`,
    orgId: opts.orgId,
    text:
      `⏱️ API token rate limit hit\n` +
      `Token: ${opts.tokenName} (${opts.memberLabel})\n` +
      `Exceeded ${opts.limit} requests in one hour; further calls return 429 until the hour rolls over.`,
  });
}
