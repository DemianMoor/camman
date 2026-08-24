import { sql } from "drizzle-orm";

import { notifyOnTransition, clearAlert } from "@/lib/alerts/alert-state";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import type { DbOrTx } from "./groups";

// Per-campaign number selection and rotation (Drip Phase 5).
//
// ⚠️ NO OVERFLOW ONTO AN UNLISTED NUMBER, EVER. When every selected number has
// hit its daily limit the journeys WAIT for the next ET day. Silently borrowing
// a number the operator did not choose would put an unknown number's carrier
// reputation at risk AND break the Phase 1 brand -> number rule at the same
// time — the two failures compound, because the borrowed number is likely
// another brand's.
//
// ⚠️ THE DAY IS AN ET-DAY-AS-TIMESTAMPTZ RANGE, never a functional predicate on
// sent_at. `date_trunc('day', sent_at AT TIME ZONE ...)` cannot use the partial
// indexes and turns a per-batch check into a seq scan of a 3.5M-row table
// (R15). Every window in this file is expressed as `sent_at >= start AND
// sent_at < end` with the bounds computed in application code.

export const NUMBERS_EXHAUSTED_ALERT = (campaignId: number) =>
  `drip:numbers_exhausted:${campaignId}`;

export interface NumberHeadroom {
  provider_phone_id: number;
  phone_number: string;
  position: number;
  daily_limit: number | null;
  sent_today: number;
  headroom: number | null; // null = unlimited
}

/**
 * The campaign's numbers with today's remaining headroom, rotation order first.
 *
 * Counts sends made TODAY (ET) from that number FOR THIS CAMPAIGN. Scoping to
 * the campaign is deliberate: a number shared with regular blasts (which is the
 * launch arrangement — phone 114 carries ~20K/day of blast traffic) would
 * otherwise show zero headroom before drip sent anything at all. The provider's
 * own pacing and the carrier caps remain the ceiling for the number overall;
 * this limit is drip's share of it.
 */
export async function numbersWithHeadroom(
  dbc: DbOrTx,
  { campaignId, now = new Date() }: { campaignId: number; now?: Date },
): Promise<NumberHeadroom[]> {
  const { start, end } = campaignDayBoundsUtc(now);
  const rows = (await dbc.execute(sql`
    SELECT n.provider_phone_id,
           pp.phone_number,
           n.position,
           n.daily_limit,
           COALESCE((
             SELECT count(*)::int FROM stage_sends ss
             WHERE ss.provider_phone_id = n.provider_phone_id
               AND ss.campaign_id = n.campaign_id
               AND ss.status IN ('sent','sending','pending')
               AND ss.created_at >= ${start.toISOString()}::timestamptz
               AND ss.created_at <  ${end.toISOString()}::timestamptz
           ), 0) AS sent_today
    FROM drip_campaign_numbers n
    JOIN provider_phones pp ON pp.id = n.provider_phone_id
    WHERE n.campaign_id = ${campaignId}
      AND pp.status = 'active'
    ORDER BY n.position, n.provider_phone_id
  `)) as unknown as {
    provider_phone_id: number; phone_number: string; position: number;
    daily_limit: number | null; sent_today: number;
  }[];

  return rows.map((r) => ({
    ...r,
    headroom: r.daily_limit == null ? null : Math.max(0, r.daily_limit - Number(r.sent_today)),
  }));
}

export interface NumberPick {
  provider_phone_id: number;
  phone_number: string;
  headroom: number | null;
}

/**
 * The next number with headroom, or null when every one is exhausted.
 *
 * Rotation is "first in position order that still has room", not round-robin:
 * with per-number limits the operator's ordering IS the preference, and a
 * strict round-robin would spread load onto a number they ranked last.
 */
export function pickNumber(numbers: NumberHeadroom[]): NumberPick | null {
  for (const n of numbers) {
    if (n.headroom === null || n.headroom > 0) {
      return {
        provider_phone_id: n.provider_phone_id,
        phone_number: n.phone_number,
        headroom: n.headroom,
      };
    }
  }
  return null;
}

/**
 * Alert when a campaign has run out of numbers for the day. State-transition
 * gated, and CLEARED when headroom returns — otherwise the alert latches and the
 * NEXT exhaustion is silent, which is the standard failure of every gated alert
 * nobody resets. Here the reset happens naturally at ET midnight.
 */
export async function reportExhaustion(
  dbc: DbOrTx,
  {
    orgId, campaignId, campaignName, exhausted, numbers,
  }: {
    orgId: string; campaignId: number; campaignName: string | null;
    exhausted: boolean; numbers: NumberHeadroom[];
  },
): Promise<void> {
  const key = NUMBERS_EXHAUSTED_ALERT(campaignId);
  if (!exhausted) {
    await clearAlert(dbc, { alertKey: key, orgId });
    return;
  }
  const detail = numbers
    .map((n) => `${n.phone_number}: ${n.sent_today}/${n.daily_limit ?? "∞"}`)
    .join(", ");
  await notifyOnTransition(dbc, {
    alertKey: key,
    orgId,
    text:
      `⚠️ Drip campaign "${campaignName ?? campaignId}" has used every selected number's daily ` +
      `limit. Leads are NOT lost — they wait for the next ET day and send then.\n${detail}\n` +
      `Add a number to the campaign or raise a limit to resume today.`,
  });
}
