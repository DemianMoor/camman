import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// Trailing volume average (ClickUp 869et3vm1, Phase 3, decision C).
//
// SENDING days, not calendar days: a day with zero sends is excluded from both
// the numerator and the denominator. On 30 Aug 2026 — a Sunday — the org sent
// nothing; averaging over calendar days would drag the mean down ~14% and make
// Monday trip a spurious ">20% above average" breach every single week.
//
// ⚠️ USE THE JOINED QUERY. Grouping stage_sends by day WITHOUT the
// campaign_stages join is 8x SLOWER (9.5-10.5s vs 1.0-1.2s): the planner
// switches to an index-only scan on stage_sends_org_phone_sent_idx and pays
// ~254,000 heap fetches. Measured in recon §7. The join is not decoration.

export interface TrailingAverage {
  /** Mean recipients per SENDING day over the window. */
  average: number;
  /** How many sending days actually contributed. */
  days: number;
  /** Those days, for the alert body — so the number can be checked by eye. */
  dayList: string[];
  /** Recipients already sent today (ET). */
  today: number;
}

export async function trailingSendingDayAverage(
  orgId: string,
  wantDays = 7,
): Promise<TrailingAverage> {
  // Look back further than `wantDays` so weekends and pauses do not shrink the
  // sample below the requested number of SENDING days.
  const rows = (await db.execute(sql`
    SELECT (ss.sent_at AT TIME ZONE 'America/New_York')::date::text AS et_day,
           count(*)::int AS sends
    FROM stage_sends ss
    JOIN campaign_stages cs ON cs.id = ss.stage_id
    WHERE ss.org_id = ${orgId}::uuid
      AND ss.status = 'sent'
      AND ss.sent_at >= now() - interval '21 days'
    GROUP BY 1
    ORDER BY 1 DESC
  `)) as unknown as { et_day: string; sends: number }[];

  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const todayRow = rows.find((r) => r.et_day === today);

  // Exclude today: it is partial, and comparing a partial day against a mean of
  // complete days would report a breach every morning and none by evening.
  const complete = rows.filter((r) => r.et_day !== today).slice(0, wantDays);

  const total = complete.reduce((a, r) => a + r.sends, 0);
  return {
    average: complete.length > 0 ? total / complete.length : 0,
    days: complete.length,
    dayList: complete.map((r) => `${r.et_day}:${r.sends.toLocaleString()}`),
    today: todayRow?.sends ?? 0,
  };
}
