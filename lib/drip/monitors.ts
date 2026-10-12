import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { clearAlert, notifyOnTransition, transitionAlert } from "@/lib/alerts/alert-state";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { telnyxBalance } from "@/lib/telnyx/client";
import { formatLatency, leadToSendLatency, type LeadLatency } from "./lead-latency";
import { checkTelnyxBalance } from "./lookup-guard";
import { isPokeEnabled } from "./poke";
import { runDripOptOutMonitor } from "./optout-monitor";
import { sweepJourneyLifecycle } from "./lifecycle-sweep";

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

// Lead-to-send regression (drip poke chain, 0206). Owner-approved 2026-10-12:
// the median over the last 15 min above 3 min fires, below 2 min resolves (the
// gap between is hysteresis — no flapping), at least 20 leads, state changes
// only. It runs only while the poke chain is ON: with it off the cron-only
// baseline is ~4–7 min by construction, and an alert red by construction
// trains people to ignore it. Multi-minute with the chain on means the chain
// is silently broken and the leads are riding the cron ticks.
export const LEAD_TO_SEND_WINDOW_MIN = 15;
export const LEAD_TO_SEND_FIRE_SEC = 180;
export const LEAD_TO_SEND_RESOLVE_SEC = 120;
export const LEAD_TO_SEND_MIN_LEADS = 20;
export const leadToSendAlertKey = (orgId: string) => `drip:lead_to_send_slow:${orgId}`;

export interface DripMonitorResult {
  optOut: Awaited<ReturnType<typeof runDripOptOutMonitor>>;
  backlogReceived: number;
  backlogAwaiting: number;
  oldestReceivedMinutes: number | null;
  oldestAwaitingMinutes: number | null;
  balanceUsd: number | null;
  balanceThreshold: number | null;
  balanceFiring: boolean;
  /** Journey terminal transitions closed on this tick (Drip Phase 6). */
  lifecycle: Awaited<ReturnType<typeof sweepJourneyLifecycle>>;
  /** Per org, last LEAD_TO_SEND_WINDOW_MIN minutes. Empty while pokes are off. */
  leadToSend: { orgId: string; latency: LeadLatency; verdict: "fire" | "resolve" | "hold" | "too_few" }[];
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
  // Drip Phase 6. Sweeps the three transitions nothing can announce:
  // converted (Keitaro's poller knows nothing of drip), completed (true when the
  // last follow-up lands) and expired (true when a clock passes). Opt-out and
  // archive close at their source instead.
  const lifecycle = await sweepJourneyLifecycle();

  // Best-effort: a latency query that fails must not stop the monitors below.
  const leadToSend = await checkLeadToSend(alerts).catch((err) => {
    console.error("[drip-monitors] lead-to-send check failed (swallowed):", err);
    return [] as DripMonitorResult["leadToSend"];
  });

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
    lifecycle,
    leadToSend,
    alerts,
  };
}

async function checkLeadToSend(alerts: string[]): Promise<DripMonitorResult["leadToSend"]> {
  const out: DripMonitorResult["leadToSend"] = [];
  if (!(await isPokeEnabled())) return out;
  const orgs = (await db.execute(sql`
    SELECT org_id FROM org_settings WHERE drip_enabled = true AND drip_poke_enabled = true
  `)) as unknown as { org_id: string }[];
  const to = new Date();
  const from = new Date(to.getTime() - LEAD_TO_SEND_WINDOW_MIN * 60_000);
  for (const { org_id: orgId } of orgs) {
    const latency = await leadToSendLatency(db, { orgId, from, to });
    const key = leadToSendAlertKey(orgId);
    const p50 = latency.p50Sec;
    if (latency.n < LEAD_TO_SEND_MIN_LEADS || p50 == null) {
      out.push({ orgId, latency, verdict: "too_few" });
      continue;
    }
    const s = latency.stepP50Sec;
    const steps =
      `lookup ${formatLatency(s.lookup)} · route ${formatLatency(s.route)} · ` +
      `queue ${formatLatency(s.queue)} · send ${formatLatency(s.send)}`;
    if (p50 > LEAD_TO_SEND_FIRE_SEC) {
      alerts.push("lead_to_send_slow");
      out.push({ orgId, latency, verdict: "fire" });
      await notifyOnTransition(db, {
        alertKey: key,
        orgId,
        text:
          `🐢 Drip lead-to-send is slow: median ${formatLatency(p50)} (p95 ${formatLatency(latency.p95Sec)}) ` +
          `over the last ${LEAD_TO_SEND_WINDOW_MIN} min, ${latency.n} leads. Hops: ${steps}. ` +
          `The poke chain may be broken — leads are riding the cron ticks. Check the [poke] and ` +
          `[lead-latency] log lines; turning drip_poke_enabled off changes nothing but speed.`,
      });
    } else if (p50 < LEAD_TO_SEND_RESOLVE_SEC) {
      out.push({ orgId, latency, verdict: "resolve" });
      // Announce recovery only when it actually was firing.
      const prior = (await db.execute(sql`
        SELECT state FROM alert_state WHERE alert_key = ${key}
      `)) as unknown as { state: string }[];
      if (prior[0]?.state === "firing" && (await transitionAlert(db, { alertKey: key, orgId, state: "ok" }))) {
        await notifyTelegram(
          `✅ Drip lead-to-send recovered: median ${formatLatency(p50)} over the last ` +
            `${LEAD_TO_SEND_WINDOW_MIN} min (${latency.n} leads).`,
        );
      }
    } else {
      out.push({ orgId, latency, verdict: "hold" });
    }
  }
  return out;
}
