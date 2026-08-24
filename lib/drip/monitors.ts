import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { telnyxBalance } from "@/lib/telnyx/client";
import { checkTelnyxBalance } from "./lookup-guard";
import { runDripOptOutMonitor } from "./optout-monitor";

// Drip monitors (Drip Phase 3). Runs as a SEPARATE cron from the sweeper it
// watches — a job that checks its own liveness reports nothing when it is the
// thing that died. Same mutual dead-man arrangement as tells-sweep/tells-monitors.
//
// ⚠️ THE BACKLOG ALERT SHIPS NOW, NOT IN PHASE 2, AND THAT ORDER MATTERS.
// In Phase 2 nothing consumed lead_inbox by design, so "unprocessed for > 10
// min" would have fired on the first lead and stayed firing forever — an alert
// that is red by construction trains people to ignore it. It ships with its
// consumer, which is this phase.
//
// ⚠️ 'awaiting_lookup' IS COUNTED SEPARATELY from 'received'. They fail for
// different reasons and need different responses: a pile of 'received' means the
// sweeper is not running; a pile of 'awaiting_lookup' means the Telnyx side is
// stuck (cap, balance, or a queue row that failed terminally). Summing them
// would let a stalled lookup hide inside a healthy-looking inbox.

const BACKLOG_STALE_MINUTES = 10;
const BACKLOG_THRESHOLD = 1; // any lead older than the window is worth surfacing

export const BACKLOG_ALERT_KEY = "drip:inbox_backlog";
export const AWAITING_ALERT_KEY = "drip:awaiting_lookup_stalled";

export interface DripMonitorResult {
  optOut: Awaited<ReturnType<typeof runDripOptOutMonitor>>;
  backlogReceived: number;
  backlogAwaiting: number;
  oldestReceivedMinutes: number | null;
  oldestAwaitingMinutes: number | null;
  balanceUsd: number | null;
  balanceThreshold: number | null;
  balanceFiring: boolean;
  alerts: string[];
}

export async function runDripMonitors(): Promise<DripMonitorResult> {
  const alerts: string[] = [];

  const rows = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE status = 'received'
        AND received_at < now() - make_interval(mins => ${BACKLOG_STALE_MINUTES}))::int
        AS backlog_received,
      count(*) FILTER (WHERE status = 'awaiting_lookup'
        AND received_at < now() - make_interval(mins => ${BACKLOG_STALE_MINUTES}))::int
        AS backlog_awaiting,
      EXTRACT(epoch FROM (now() - min(received_at) FILTER (WHERE status = 'received'))) / 60
        AS oldest_received_min,
      EXTRACT(epoch FROM (now() - min(received_at) FILTER (WHERE status = 'awaiting_lookup'))) / 60
        AS oldest_awaiting_min
    FROM lead_inbox
  `)) as unknown as {
    backlog_received: number;
    backlog_awaiting: number;
    oldest_received_min: string | number | null;
    oldest_awaiting_min: string | number | null;
  }[];

  const r = rows[0];
  const backlogReceived = Number(r?.backlog_received ?? 0);
  const backlogAwaiting = Number(r?.backlog_awaiting ?? 0);
  const oldestReceived = r?.oldest_received_min == null ? null : Math.round(Number(r.oldest_received_min));
  const oldestAwaiting = r?.oldest_awaiting_min == null ? null : Math.round(Number(r.oldest_awaiting_min));

  // ── the sweeper is not keeping up (or is not running) ──────────────────
  if (backlogReceived >= BACKLOG_THRESHOLD) {
    alerts.push("backlog_received");
    await notifyOnTransition(db, {
      alertKey: BACKLOG_ALERT_KEY,
      text:
        `🚨 Drip intake backlog: ${backlogReceived} lead(s) have been unprocessed for more than ` +
        `${BACKLOG_STALE_MINUTES} minutes (oldest ${oldestReceived} min). ` +
        `The lead-enrichment sweeper may not be running — check /api/cron/lead-enrichment ` +
        `and its cron_locks lease.`,
    });
  } else {
    await clearAlert(db, { alertKey: BACKLOG_ALERT_KEY });
  }

  // ── the lookup side is stuck ───────────────────────────────────────────
  if (backlogAwaiting >= BACKLOG_THRESHOLD) {
    alerts.push("backlog_awaiting");
    await notifyOnTransition(db, {
      alertKey: AWAITING_ALERT_KEY,
      text:
        `🚨 Drip leads stalled awaiting lookup: ${backlogAwaiting} lead(s) parked for more than ` +
        `${BACKLOG_STALE_MINUTES} minutes (oldest ${oldestAwaiting} min). ` +
        `This is the Telnyx side, not the sweeper: check the drip daily sub-cap, the account ` +
        `balance, and whether lookup_queue rows for these numbers failed terminally.`,
    });
  } else {
    await clearAlert(db, { alertKey: AWAITING_ALERT_KEY });
  }

  // ── Telnyx balance / top-up ────────────────────────────────────────────
  let balanceUsd: number | null = null;
  let balanceThreshold: number | null = null;
  let balanceFiring = false;
  const bal = await telnyxBalance();
  if (bal.ok) {
    balanceUsd = bal.availableCredit;
    const verdict = await checkTelnyxBalance(db, { balanceUsd: bal.availableCredit });
    balanceThreshold = verdict.threshold;
    balanceFiring = verdict.firing;
    if (verdict.firing) alerts.push("balance_low");
  } else {
    // A balance we cannot read is not a balance that is fine. Surfaced, but not
    // as the low-balance alert — that would misattribute an API outage to a
    // funding problem and send someone to the wrong dashboard.
    console.error(`[drip-monitors] balance check failed: ${bal.error}`);
    alerts.push("balance_unreadable");
  }

  // ── per-campaign, per-ET-day opt-out monitor (G7) ──────────────────────
  // Runs here rather than in the scheduler so it still evaluates when the
  // scheduler has nothing to do — a campaign that stopped sending an hour ago
  // can still cross a threshold as its STOPs arrive.
  const optOut = await runDripOptOutMonitor();
  for (const v of optOut) {
    if (v.level !== "ok") alerts.push(`optout_${v.level}:${v.campaign_id}`);
  }

  return {
    optOut,
    backlogReceived,
    backlogAwaiting,
    oldestReceivedMinutes: oldestReceived,
    oldestAwaitingMinutes: oldestAwaiting,
    balanceUsd,
    balanceThreshold,
    balanceFiring,
    alerts,
  };
}
