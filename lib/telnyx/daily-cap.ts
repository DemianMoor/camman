import "server-only";

import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// The daily cap is anchored to Warsaw local days (per the brief). Rates/pause/cap
// govern the one Telnyx account, so this is account-global, not per-org.
export const LOOKUP_TIMEZONE = "Europe/Warsaw";

// UTC instant of the most recent Warsaw local midnight at or before `now`. Pure.
export function warsawMidnightUtc(now: Date): Date {
  const local = toZonedTime(now, LOOKUP_TIMEZONE); // now in Warsaw wall-clock
  const localMidnight = new Date(
    local.getFullYear(),
    local.getMonth(),
    local.getDate(),
    0,
    0,
    0,
    0,
  );
  return fromZonedTime(localMidnight, LOOKUP_TIMEZONE); // back to a UTC instant
}

// Attempts consumed today = SUM of lookup_queue.attempts over rows touched since
// Warsaw midnight. We SUM attempts (each attempt = one Telnyx call), not COUNT
// rows, so a number that 429s twice then succeeds consumes 3, not 1. Sourced from
// the queue (not phone_lookups.looked_up_at) so failed calls + retries consume cap.
export async function countAttemptsToday(now: Date = new Date()): Promise<number> {
  const since = warsawMidnightUtc(now);
  const rows = await db.execute<{ used: string | null }>(sql`
    SELECT COALESCE(SUM(attempts), 0)::text AS used
    FROM lookup_queue
    WHERE attempts >= 1 AND updated_at >= ${since.toISOString()}
  `);
  return Number(rows[0]?.used ?? 0);
}

export function remainingCap(cap: number, used: number): number {
  return Math.max(0, cap - used);
}
