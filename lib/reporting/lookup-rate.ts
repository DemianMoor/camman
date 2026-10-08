import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import type { DbOrTx } from "@/lib/drip/groups";

// Per-lookup cost, calibrated from the Telnyx balance ledger (Drip P7, R1).
//
// ⚠️ THE PER-BATCH DELTA IS NEVER USED FOR BILLING, and the reason is measured,
// not theoretical. Across the 15 batches that carry both balances the implied
// rate ranges from $0.000000 to $0.005889 per lookup — 0x to 3.9x the flat rate:
//
//   • SMALL BATCHES READ AS FREE. Four of fifteen have delta 0.0000, and they
//     are exactly the drip_intake batches (1-2 lookups each). Invoicing a drip
//     partner from the per-batch delta bills them $0.00.
//   • CONCURRENT BATCHES SHARE A SNAPSHOT. Two 2026-07-21 batches both recorded
//     balance_before = 524.5600; three 2026-08-24 batches all recorded 52.4700.
//     The balance is one account figure, so overlapping batches each claim the
//     whole window's movement or none of it.
//
// In AGGREGATE it is sound: 1002.84 / 613,494 lookups = $0.001635, against a
// $0.0015 flat rate. So the ledger sets the RATE over a trailing window and
// lead_intake_daily.lookups_spent does the ATTRIBUTION — which is also the only
// attribution available, since nothing ties a lookup to a partner.
//
// ⚠️ actual_cost_usd IS NOT ACTUAL. It equals est_cost_usd in 15 of 15 rows.
// Nothing here reads it.
//
// ⭐ ONLY BULK BATCHES CALIBRATE (2026-10-08, C1 of the partner-attribution
// plan). drip_intake batches are 1-2 lookups each, and their balance deltas are
// not noise around the price — they are the failure above, 200 times over: on
// prod 190 of 200 read <= 0 and the rest sum to $1.52 over 14,237 lookups,
// $0.000108 per lookup, one fourteenth of the real price. Left in the window
// they drag the rate down a little; left ALONE in the window — which is what
// happens once the upload batches age past 90 days — they would keep the rate
// "ledger" at a 14x discount, because the sum is positive. So the ledger rate
// is read from upload / backfill batches only, and a window with none of them
// falls to the flat rate and SAYS so (source "flat"), never "ledger".

/** Fallback when the window yields no usable ledger movement. */
export const FLAT_RATE_USD = 0.0015;

/** How far back the rate is calibrated. Long enough to average out the noise. */
export const CALIBRATION_DAYS = 90;

/**
 * The batch triggers whose ledger movement is trusted for calibration. A
 * drip_intake batch is excluded by construction, not by a size threshold —
 * a 1-lookup upload batch would be just as worthless, but uploads are never
 * that small and a threshold is a number somebody has to keep right.
 */
export const CALIBRATION_TRIGGERS = ["upload", "backfill"] as const;

export interface LookupRate {
  /** USD per lookup actually used for the report. */
  rate: number;
  /** "ledger" when calibrated from real balance movement, "flat" when not. */
  source: "ledger" | "flat";
  /** Inclusive ET dates the calibration covered — shown so an invoice explains itself. */
  from: string | null;
  to: string | null;
  /** The raw inputs, so the number can be re-derived by hand. */
  ledgerDeltaUsd: number | null;
  lookupsProcessed: number | null;
  batches: number;
}

/**
 * Calibrate USD-per-lookup from the trailing ledger.
 *
 * ⚠️ FAILS TOWARD THE FLAT RATE, never toward zero. A window with no batches, no
 * balance snapshots, or a non-positive delta (a top-up landing mid-window can
 * make the balance RISE) yields `source: "flat"` rather than a rate of 0 — a
 * zero rate would silently invoice every partner nothing, which is precisely the
 * failure the per-batch delta already exhibits.
 */
export async function getCalibratedLookupRate(
  days = CALIBRATION_DAYS,
  /** Executor — a transaction in tests so rolled-back fixtures are visible. */
  dbc: DbOrTx = db,
): Promise<LookupRate> {
  const rows = (await dbc.execute(sql`
    SELECT
      count(*)::int                                        AS batches,
      sum(balance_before_usd - balance_after_usd)::float8   AS delta,
      sum(processed)::int                                   AS processed,
      min(created_at AT TIME ZONE 'America/New_York')::date::text AS from_day,
      max(created_at AT TIME ZONE 'America/New_York')::date::text AS to_day
    FROM lookup_batches
    WHERE balance_before_usd IS NOT NULL
      AND balance_after_usd IS NOT NULL
      AND created_at >= now() - make_interval(days => ${days})
      -- bulk batches only — see the header. The drip rows are not merely
      -- down-weighted, they are absent from every figure reported below.
      AND trigger IN (${sql.join(CALIBRATION_TRIGGERS.map((t) => sql`${t}`), sql`, `)})
  `)) as unknown as {
    batches: number;
    delta: number | null;
    processed: number | null;
    from_day: string | null;
    to_day: string | null;
  }[];

  const r = rows[0];
  const delta = r?.delta ?? null;
  const processed = r?.processed ?? null;

  if (!processed || processed <= 0 || delta == null || delta <= 0) {
    return {
      rate: FLAT_RATE_USD,
      source: "flat",
      from: r?.from_day ?? null,
      to: r?.to_day ?? null,
      ledgerDeltaUsd: delta,
      lookupsProcessed: processed,
      batches: r?.batches ?? 0,
    };
  }

  return {
    rate: delta / processed,
    source: "ledger",
    from: r.from_day,
    to: r.to_day,
    ledgerDeltaUsd: delta,
    lookupsProcessed: processed,
    batches: r.batches,
  };
}

/** Cost for a partner's lookups at the calibrated rate. */
export function lookupCostUsd(lookups: number, rate: LookupRate): number {
  return lookups * rate.rate;
}

/** One sentence an operator (or a partner) can check the invoice against. */
export function describeRate(rate: LookupRate): string {
  if (rate.source === "flat") {
    return (
      `$${rate.rate.toFixed(6)} per lookup (standard rate — no bulk lookup batch ` +
      `with usable balance movement in the last ${CALIBRATION_DAYS} days).`
    );
  }
  return (
    `$${rate.rate.toFixed(6)} per lookup, calibrated from $${rate.ledgerDeltaUsd!.toFixed(2)} ` +
    `of metered balance across ${rate.lookupsProcessed!.toLocaleString()} lookups ` +
    `(${rate.batches} bulk batches, ${rate.from} to ${rate.to}).`
  );
}
