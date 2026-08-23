import { sql } from "drizzle-orm";

import { notifyOnTransition, clearAlert } from "@/lib/alerts/alert-state";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import type { DbOrTx } from "./groups";

// Drip lookup guards (Drip Phase 3, ruling G20/G21).
//
// ⚠️ TWO DIFFERENT DAY BOUNDARIES LIVE HERE, deliberately, and confusing them
// would silently double or halve a budget:
//
//   * The ACCOUNT-GLOBAL cap (lookup_settings.lookup_daily_cap) is anchored to
//     WARSAW midnight in lib/telnyx/daily-cap.ts. Untouched — it governs the
//     whole Telnyx account, not just drip.
//   * The DRIP SUB-CAP below is counted per ET CALENDAR DAY, like every other
//     drip-facing number.
//
// Warsaw midnight is 18:00 ET — measured, not assumed — i.e. INSIDE the
// 8AM-9PM ET drip window. So one ET drip day straddles two global cap days, and
// the global cap can exhaust mid-afternoon ET and refill at 6PM. Anything that
// surfaces either number must say which day it means.

export const DRIP_BALANCE_ALERT_KEY = "drip:telnyx_balance_low";

export interface DripCapDecision {
  allowed: number;
  spentToday: number;
  cap: number;
}

/**
 * How many Telnyx calls drip may still make today (ET).
 *
 * Counts `lookups_spent` — Telnyx calls actually made — not leads, because a
 * cache hit costs nothing and must not consume the budget. Returns the number
 * ALLOWED, so the caller enqueues at most that many and leaves the rest in
 * `awaiting_lookup` for the next tick. Failing this way is the point: leads
 * WAIT, they never silently proceed as if the lookup had said "not mobile".
 */
export async function dripLookupBudget(
  dbc: DbOrTx,
  { orgId, want, now = new Date() }: { orgId: string; want: number; now?: Date },
): Promise<DripCapDecision> {
  const settings = (await dbc.execute(sql`
    SELECT drip_daily_cap FROM lookup_settings LIMIT 1
  `)) as unknown as { drip_daily_cap: number }[];
  const cap = Number(settings[0]?.drip_daily_cap ?? 0);

  const { start } = campaignDayBoundsUtc(now);
  const spent = (await dbc.execute(sql`
    SELECT COALESCE(SUM(lookups_spent), 0)::int AS n
    FROM lead_intake_daily
    WHERE org_id = ${orgId}::uuid
      AND day_et = (${start.toISOString()}::timestamptz AT TIME ZONE 'America/New_York')::date
  `)) as unknown as { n: number }[];
  const spentToday = Number(spent[0]?.n ?? 0);

  return { allowed: Math.max(0, Math.min(want, cap - spentToday)), spentToday, cap };
}

/**
 * Telnyx top-up alert (ruling G20).
 *
 *   alert when balance < GREATEST(7 x avg_daily_spend_7d, balance_floor_usd)
 *
 * ⚠️ THE FLOOR IS NOT A SAFETY NET, IT IS THE ONLY WORKING HALF AT LAUNCH.
 * Seven-day lookup spend was $0.00 when this was written (no batches since
 * 2026-08-10), so `7 x avg` evaluates to $0 and `balance < 0` is false —
 * the alert would never fire, exactly when drip first needs it. Spend stays $0
 * right up to the moment drip turns on, so a purely historical threshold is
 * guaranteed silent on day one.
 *
 * State-transition gated, and CLEARED when the balance recovers — otherwise the
 * alert latches 'firing' forever and the NEXT drop is silent, which is the
 * standard failure of every gated alert nobody resets.
 */
export async function checkTelnyxBalance(
  dbc: DbOrTx,
  { balanceUsd }: { balanceUsd: number },
): Promise<{ threshold: number; firing: boolean; avgDaily: number; floor: number }> {
  const rows = (await dbc.execute(sql`
    SELECT
      (SELECT balance_floor_usd FROM lookup_settings LIMIT 1) AS floor,
      COALESCE((
        SELECT SUM(COALESCE(actual_cost_usd, 0)) / 7.0
        FROM lookup_batches
        WHERE created_at > now() - interval '7 days'
      ), 0) AS avg_daily
  `)) as unknown as { floor: string | number; avg_daily: string | number }[];

  const floor = Number(rows[0]?.floor ?? 50);
  const avgDaily = Number(rows[0]?.avg_daily ?? 0);
  const threshold = Math.max(7 * avgDaily, floor);
  const firing = balanceUsd < threshold;

  if (firing) {
    await notifyOnTransition(dbc, {
      alertKey: DRIP_BALANCE_ALERT_KEY,
      text:
        `⚠️ Telnyx balance $${balanceUsd.toFixed(2)} is below the top-up threshold ` +
        `$${threshold.toFixed(2)} ` +
        `(greater of 7 x avg daily spend $${(7 * avgDaily).toFixed(2)} and the floor ` +
        `$${floor.toFixed(2)}).\n` +
        `Drip lead enrichment needs a lookup per new number — leads will park in ` +
        `awaiting_lookup rather than being processed once the balance runs out.`,
    });
  } else {
    // Recovery re-arms the alert for the next drop.
    await clearAlert(dbc, { alertKey: DRIP_BALANCE_ALERT_KEY });
  }

  return { threshold, firing, avgDaily, floor };
}
