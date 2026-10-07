import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { txrPassKey } from "@/lib/sends/textrequest-messages-poll";

// =============================================================================
// Text Request poll — run health alerts (ClickUp 869fcqhcu)
//
// Two failures went unalerted on 2026-10-05: every poll run from 23:04 to 05:04
// UTC was killed at Vercel's 60 s limit (25 in a row), and dashboard 68804 was
// never walked. The poll's own Telegram alert fires on a failed API call — a
// run that is KILLED cannot report itself, and a dashboard that is simply never
// reached raises nothing. (A page cap is a log line only since 2026-10-07: the
// capped range is owed and caught up, and check 2 below alerts if it isn't.)
//
//   1. "Did not finish": each cron run stamps `started` first and `finished`
//      last. A run that finds started > finished knows the previous one died.
//      At most one cron interval (15 min) late. Plus HEARTBEAT_JOBS
//      .textrequestPoll on `finished`, watched hourly by tells-monitors, for a
//      cron that stops firing altogether.
//   2. "No full pass": a dashboard+direction whose last complete walk is older
//      than N runs. Outbound N = 4 (1 h): owed ranges are kept, so outbound
//      lateness is not loss, and an hour is long before anything ages out.
//      Inbound N = 2 (30 min): inbound is the STOP backstop.
//
// Each alert fires ONCE per streak (a flag row) and sends a recovery message
// when it clears. All state lives in cron_locks rows; no migration.
// =============================================================================

export const TXR_POLL_STARTED = "textrequest-poll:started";
export const TXR_POLL_FINISHED = "textrequest-poll:finished";
const DIED_ALERTED = "textrequest-poll:died-alerted";

export const TXR_POLL_CADENCE_MIN = 15;
export const TXR_PASS_RUNS: Record<"R" | "S", number> = { R: 2, S: 4 };
/** A run lands a few minutes after its slot; this keeps an on-time run from reading as missed. */
const PASS_SLACK_MIN = 5;

export function txrPassThresholdMin(direction: "R" | "S"): number {
  return TXR_PASS_RUNS[direction] * TXR_POLL_CADENCE_MIN + PASS_SLACK_MIN;
}

const passAlertedKey = (d: string, dir: "R" | "S") => `textrequest-poll:pass-alerted:${d}:${dir}`;
// When a dashboard has NEVER completed a pass, this records when the check first
// saw it, so a newly configured number gets the same N runs as everyone else
// instead of alerting on its first look.
const passSeenKey = (d: string, dir: "R" | "S") => `textrequest-poll:pass-seen:${d}:${dir}`;

/** Did the previous run die? Pure. */
export function txrPreviousRunDied(started: Date | null, finished: Date | null): boolean {
  if (!started) return false;
  return !finished || started > finished;
}

/** Alert transition for one streak flag. Pure. */
export function txrAlertTransition(breached: boolean, alreadyAlerted: boolean): "alert" | "recover" | "none" {
  if (breached && !alreadyAlerted) return "alert";
  if (!breached && alreadyAlerted) return "recover";
  return "none";
}

type Dbc = typeof db;

async function read(dbc: Dbc, keys: string[]): Promise<Map<string, Date | null>> {
  if (keys.length === 0) return new Map();
  const rows = (await dbc.execute(sql`
    SELECT job_name, watermark FROM cron_locks
    WHERE job_name = ANY(${sql`ARRAY[${sql.join(keys.map((k) => sql`${k}`), sql`, `)}]::text[]`})
  `)) as unknown as { job_name: string; watermark: string | Date | null }[];
  return new Map(rows.map((r) => [r.job_name, r.watermark == null ? null : new Date(r.watermark)]));
}

async function stampNow(dbc: Dbc, key: string): Promise<void> {
  await dbc.execute(sql`
    INSERT INTO cron_locks (job_name, watermark) VALUES (${key}, now())
    ON CONFLICT (job_name) DO UPDATE SET watermark = now()
  `);
}

async function remove(dbc: Dbc, key: string): Promise<void> {
  await dbc.execute(sql`DELETE FROM cron_locks WHERE job_name = ${key}`);
}

export interface TxrRunStart {
  previous_died: boolean;
  previous_started: string | null;
  alerted: boolean;
}

/** First thing a CRON run does. Manual runs must not call this (they bypass the lease). */
export async function beginTxrPollRun(dbc: Dbc): Promise<TxrRunStart> {
  const s = await read(dbc, [TXR_POLL_STARTED, TXR_POLL_FINISHED, DIED_ALERTED]);
  const started = s.get(TXR_POLL_STARTED) ?? null;
  const died = txrPreviousRunDied(started, s.get(TXR_POLL_FINISHED) ?? null);
  let alerted = false;
  if (txrAlertTransition(died, s.has(DIED_ALERTED)) === "alert") {
    await notifyTelegram(
      `🚨 <b>Text Request poll did not finish</b>\n` +
        `The run started ${started?.toISOString()} never completed (killed at the 60 s limit or crashed). ` +
        `While this repeats, delivery receipts, the contacts opt-out backstop and webhook health may not run.`,
    ).catch(() => {});
    await stampNow(dbc, DIED_ALERTED);
    alerted = true;
  }
  await stampNow(dbc, TXR_POLL_STARTED);
  return { previous_died: died, previous_started: started?.toISOString() ?? null, alerted };
}

/** Last thing a CRON run does. */
export async function finishTxrPollRun(dbc: Dbc): Promise<{ recovered: boolean }> {
  const s = await read(dbc, [DIED_ALERTED]);
  await stampNow(dbc, TXR_POLL_FINISHED);
  if (s.has(DIED_ALERTED)) {
    await remove(dbc, DIED_ALERTED);
    await notifyTelegram(`✅ Text Request poll is completing again.`).catch(() => {});
    return { recovered: true };
  }
  return { recovered: false };
}

export interface TxrPassCheck {
  dashboard_id: string;
  direction: "R" | "S";
  age_min: number;
  threshold_min: number;
  breached: boolean;
  transition: "alert" | "recover" | "none";
}

/** After the walks: alert on any dashboard+direction without a complete pass in N runs. */
export async function checkTxrPassAges(dbc: Dbc, dashboards: string[]): Promise<TxrPassCheck[]> {
  const pairs = dashboards.flatMap((d) => (["R", "S"] as const).map((dir) => ({ d, dir })));
  // Record "first seen" for pairs that have never passed; keeps the FIRST stamp.
  for (const { d, dir } of pairs) {
    await dbc.execute(sql`
      INSERT INTO cron_locks (job_name, watermark) VALUES (${passSeenKey(d, dir)}, now())
      ON CONFLICT (job_name) DO NOTHING
    `);
  }
  const s = await read(dbc, pairs.flatMap(({ d, dir }) => [txrPassKey(d, dir), passSeenKey(d, dir), passAlertedKey(d, dir)]));
  const nowRow = (await dbc.execute(sql`SELECT now() AS now`)) as unknown as { now: string | Date }[];
  const now = new Date(nowRow[0].now).getTime();

  const out: TxrPassCheck[] = [];
  const breaches: string[] = [];
  const recoveries: string[] = [];
  for (const { d, dir } of pairs) {
    const since = s.get(txrPassKey(d, dir)) ?? s.get(passSeenKey(d, dir)) ?? null;
    const age = since ? (now - since.getTime()) / 60_000 : 0;
    const threshold = txrPassThresholdMin(dir);
    const breached = age > threshold;
    const transition = txrAlertTransition(breached, s.has(passAlertedKey(d, dir)));
    const label = `dashboard ${d} ${dir === "S" ? "outbound (receipts)" : "inbound (STOP backstop)"}`;
    if (transition === "alert") {
      breaches.push(`${label}: no complete pass for ${Math.round(age)} min (limit ${threshold} min = ${TXR_PASS_RUNS[dir]} runs)`);
      await stampNow(dbc, passAlertedKey(d, dir));
    } else if (transition === "recover") {
      recoveries.push(label);
      await remove(dbc, passAlertedKey(d, dir));
    }
    out.push({ dashboard_id: d, direction: dir, age_min: Math.round(age), threshold_min: threshold, breached, transition });
  }
  if (breaches.length > 0) {
    await notifyTelegram(
      `⚠️ <b>Text Request poll is falling behind</b>\n` + breaches.map((b) => `• ${b}`).join("\n") +
        `\nOutbound ranges are kept and read on later runs; inbound STOPs older than the 6 h window are not.`,
    ).catch(() => {});
  }
  if (recoveries.length > 0) {
    await notifyTelegram(`✅ Text Request poll caught up: ${recoveries.join(", ")}.`).catch(() => {});
  }
  return out;
}
