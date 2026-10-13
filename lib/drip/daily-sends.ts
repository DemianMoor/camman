import { sql, type SQL } from "drizzle-orm";

// ⭐ THE ONE DEFINITION of "a drip send that counts against the daily send cap".
//
// Three readers: the scheduler (first sends), the follow-up runner, and the
// router's send-capacity rule (0210). If the router counted differently from
// the scheduler, it would admit leads the scheduler then refuses (the backlog
// this rule exists to stop) or defer leads the scheduler could have sent.
//
// Every drip send on the campaign counts, first sends and follow-ups alike — a
// follow-up costs the same money and the same carrier reputation. Over the ET
// day as a RANGE, never a functional predicate on created_at (R15).
// The caller's stage_sends alias must be `ss`.
export function dripDailySendsPredicate(dayStart: Date, dayEnd: Date): SQL {
  return sql`ss.status IN ('sent','sending','pending')
    AND ss.created_at >= ${dayStart.toISOString()}::timestamptz
    AND ss.created_at <  ${dayEnd.toISOString()}::timestamptz`;
}

/**
 * Send capacity (0210): is the campaign full for today?
 *
 *   full  ⇔  S + U ≥ daily_cap
 *   S = today's drip sends (dripDailySendsPredicate)
 *   U = routed journeys with no first send yet, from ANY day (the backlog)
 *
 * S and U never overlap — the first send row and the journey's first_send_at
 * stamp are written in one transaction — so sending moves a journey from U to S
 * without changing S + U, and a per-tick count stays true while the scheduler
 * runs. No cap ⇒ never full.
 */
export function sendCapacity(
  dailyCap: number | null,
  sendsToday: number,
  unsent: number,
): { full: boolean; committed: number; detail: string | null } {
  const committed = sendsToday + unsent;
  if (dailyCap == null || committed < dailyCap) return { full: false, committed, detail: null };
  return {
    full: true,
    committed,
    detail: `campaign full (${committed}/${dailyCap} today: ${sendsToday} sent + ${unsent} queued)`,
  };
}
