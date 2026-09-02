import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// "Proven creative" (ClickUp 869et3vm1, Phase 3).
//
// Proven = the creative has sends on ≥ 2 CONSECUTIVE SENDING DAYS. Dmytro,
// 2026-08-31: it is a DERIVED state, not a manual approval flag — there is no
// `approved` column and no approval step, and the cap lifts by itself once the
// history says so.
//
// ── ONE QUERY PER PREPARE, NOT ONE PER STAGE ──────────────────────────────
//
// The joined form below costs ~1.0-1.2s warm against production (recon §7:
// index scan on stage_sends_org_sent_at_idx over ~503K rows, hash-joined to a
// 1,466-row campaign_stages). That is fine ONCE. Run per stage in a loop and a
// campaign with a dozen lanes pays fifteen seconds inside a request a human is
// waiting on.
//
// So the contract is: `loadCreativeSendHistory(orgId)` is called ONCE per
// Prepare and returns a lookup covering EVERY creative; `isProven(history, id)`
// is a pure map read. Callers must not call the loader inside a loop, and
// scripts/test-proven-creative-query-count.ts asserts exactly one execution per
// Prepare by counting the statement in pg_stat_statements.
//
// ⚠️ Do NOT "optimise" this by adding a WHERE creative_id = $1 and calling it
// per stage. That is the shape this comment exists to prevent.

/** creative_id → the ET dates it sent on, ascending. */
export type CreativeSendHistory = Map<number, string[]>;

/**
 * Sends per creative per ET day over a trailing window, in ONE query.
 *
 * 9 days is enough to answer "≥2 consecutive sending days" with room for a
 * weekend gap; it is not a tunable, just a bound that keeps the scan small.
 */
export async function loadCreativeSendHistory(
  orgId: string,
  windowDays = 9,
): Promise<CreativeSendHistory> {
  const rows = (await db.execute(sql`
    SELECT cs.creative_id AS creative_id,
           (ss.sent_at AT TIME ZONE 'America/New_York')::date::text AS et_day
    FROM stage_sends ss
    JOIN campaign_stages cs ON cs.id = ss.stage_id
    WHERE ss.org_id = ${orgId}::uuid
      AND ss.status = 'sent'
      AND ss.sent_at >= now() - (${windowDays}::text || ' days')::interval
      AND cs.creative_id IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1, 2
  `)) as unknown as { creative_id: number; et_day: string }[];

  const out: CreativeSendHistory = new Map();
  for (const r of rows) {
    const list = out.get(r.creative_id);
    if (list) list.push(r.et_day);
    else out.set(r.creative_id, [r.et_day]);
  }
  return out;
}

function isConsecutive(a: string, b: string): boolean {
  const da = Date.parse(a + "T00:00:00Z");
  const dbb = Date.parse(b + "T00:00:00Z");
  return dbb - da === 86_400_000;
}

/**
 * Proven = sends on at least two consecutive calendar days.
 *
 * Consecutive CALENDAR days, deliberately: "two consecutive sending days" would
 * make a creative that ran Friday and Monday proven, which is not what "two days
 * running" means to anyone reading it. A weekend gap resets the streak, and that
 * is the conservative direction — it delays the cap lifting rather than lifting
 * it early.
 */
export function isProven(history: CreativeSendHistory, creativeId: number): boolean {
  const days = history.get(creativeId);
  if (!days || days.length < 2) return false;
  for (let i = 1; i < days.length; i++) {
    if (isConsecutive(days[i - 1], days[i])) return true;
  }
  return false;
}

/** Sends for a creative on the current ET day, from the same loaded history. */
export function sentToday(history: CreativeSendHistory, creativeId: number): boolean {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  return (history.get(creativeId) ?? []).includes(today);
}

/**
 * The WARN threshold: an unproven creative assigned more than this many
 * recipients in a day gets a Telegram warning. It does NOT block — Dmytro,
 * 2026-08-31: "unproven creative over 10,000 sends/day is WARN, not block. The
 * stage proceeds."
 */
export const UNPROVEN_DAILY_WARN_THRESHOLD = 10_000;
