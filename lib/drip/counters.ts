import { sql } from "drizzle-orm";

import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import type { DbOrTx } from "./groups";

// lead_intake_daily counters (Drip Phase 3).
//
// ⚠️ THESE MUST BE WRITTEN IN THE SAME TRANSACTION AS THE THING THEY COUNT.
// Landline leads are counted and then DELETED from lead_inbox, so a counter
// written afterwards in a separate statement leaves a window where a crash
// loses the lead entirely — no row, no count, and a partner's volume silently
// understated. Every caller here passes the enclosing `tx`.

export type CounterColumn =
  | "received"
  | "mobile"
  | "voip"
  | "unknown"
  | "landline"
  | "rejected"
  | "duplicate"
  | "sandbox"
  | "lookups_spent";

const ALLOWED: readonly CounterColumn[] = [
  "received", "mobile", "voip", "unknown", "landline",
  "rejected", "duplicate", "sandbox", "lookups_spent",
];

/** ET calendar day as YYYY-MM-DD — the counter's grain. */
export function etDay(at: Date = new Date()): string {
  return formatInCampaignTimezone(at, "yyyy-MM-dd");
}

/**
 * Start of the hour containing `at` — the hourly counter's grain.
 *
 * Truncating in UTC is correct for ET: its offset (−4/−5) is a whole number of
 * hours, so the ET hour boundary IS the UTC hour boundary, and on the DST
 * fall-back day the two 01:00 ET hours stay two distinct instants.
 */
export function hourStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000);
}

/**
 * Add to one or more counters for (partner_key, tag) at BOTH grains: the ET-day
 * row in lead_intake_daily and the hour row in lead_intake_hourly (0199).
 *
 * ⚠️ ONE STATEMENT, BOTH TABLES. The two upserts are a single data-modifying
 * CTE, so they commit or fail together even for a caller passing the bare `db`
 * (the lookups_spent bump in enrichment.ts does). Two statements on a pool
 * could leave the daily row bumped and the hourly one not, and the hourly
 * digest's day-sum invariant would report a divergence nobody could explain.
 * Day and hour both derive from the same `at`, so they can never straddle
 * midnight differently.
 *
 * ⚠️ Column names are interpolated with sql.raw, so they are checked against an
 * allowlist first. `deltas` keys come from application code today, but an
 * allowlist is the difference between "currently safe" and "safe" — a future
 * caller passing a partner-controlled string must not be able to reach the
 * statement text.
 */
export async function bumpIntakeCounters(
  dbc: DbOrTx,
  {
    orgId,
    partnerKeyId,
    at,
    interestTag,
    deltas,
  }: {
    orgId: string;
    partnerKeyId: number;
    /** When the outcome was counted (processing time). Sets day AND hour. */
    at: Date;
    /**
     * The RESOLVED tag (Drip P7) — what routing will actually match on, not what
     * the payload supplied. `null`/absent becomes '' ("untagged"), which is a
     * real value that conflicts with itself: a NULL here would make every
     * untagged row a fresh PK and silently under-count.
     */
    interestTag?: string | null;
    deltas: Partial<Record<CounterColumn, number>>;
  },
): Promise<void> {
  const entries = Object.entries(deltas).filter(([, v]) => (v ?? 0) !== 0) as [
    CounterColumn,
    number,
  ][];
  if (entries.length === 0) return;

  for (const [col] of entries) {
    if (!ALLOWED.includes(col)) throw new Error(`bumpIntakeCounters: illegal column ${col}`);
  }

  const cols = entries.map(([c]) => sql.raw(c));
  const vals = entries.map(([, n]) => sql`${n}`);
  const setsFor = (table: string) =>
    entries.map(
      ([c, n]) => sql`${sql.raw(c)} = ${sql.raw(table)}.${sql.raw(c)} + ${n}`,
    );
  const tag = (interestTag ?? "").trim();
  const colList = sql.join(cols, sql`, `);
  const valList = sql.join(vals, sql`, `);

  await dbc.execute(sql`
    WITH daily AS (
      INSERT INTO lead_intake_daily (org_id, partner_key_id, day_et, interest_tag, ${colList})
      VALUES (${orgId}::uuid, ${partnerKeyId}, ${etDay(at)}::date, ${tag}, ${valList})
      ON CONFLICT (org_id, partner_key_id, day_et, interest_tag)
      DO UPDATE SET ${sql.join(setsFor("lead_intake_daily"), sql`, `)}
      RETURNING 1
    )
    INSERT INTO lead_intake_hourly (org_id, partner_key_id, hour_et, interest_tag, ${colList})
    VALUES (${orgId}::uuid, ${partnerKeyId}, ${hourStart(at).toISOString()}::timestamptz, ${tag}, ${valList})
    ON CONFLICT (org_id, partner_key_id, hour_et, interest_tag)
    DO UPDATE SET ${sql.join(setsFor("lead_intake_hourly"), sql`, `)}
  `);
}

/**
 * Map a resolved line type to its counter column.
 *
 * Per ruling G19 voip and unknown are their own columns, NOT folded into
 * mobile: all three are processed identically, and the only reason to keep them
 * is so Phase 4 can decide to filter — which it cannot do on a number nobody
 * counted. A null line type (never looked up) counts as `unknown`, which is
 * honest: we do not know.
 */
export function counterForLineType(lineType: string | null): CounterColumn {
  switch (lineType) {
    case "mobile":
      return "mobile";
    case "voip":
      return "voip";
    case "landline":
      return "landline";
    default:
      return "unknown";
  }
}
