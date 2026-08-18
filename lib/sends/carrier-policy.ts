import { sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE, CAMPAIGN_TIMEZONE_LABEL } from "@/lib/campaign-timezone";

// Q4 — the per-NUMBER carrier allow-list, as ONE clause shared by every path
// that resolves a stage's audience.
//
// ⚠️ ENFORCED AT MATERIALIZATION, never as a skip at drain. A contact excluded
// on carrier grounds must never become a `stage_sends` row: a row that exists
// but is skipped later still shows up in reconciliation, in the pool/attempted
// arithmetic, and in the operator's sense of "who this stage is going to". The
// audience is the place to say no.
//
// ⚠️ ABSENT ROW = ALLOWED. `phone_carrier_limits` is an EXCEPTION list. A
// number with no rows sends to every carrier, which is why the empty table is a
// byte-for-byte no-op today. Reading absence as "denied" would mute every
// number in the org, so the SQL below is written as an anti-join (NOT EXISTS a
// disallowing row) rather than a membership test.

// The three unknown-ish buckets. They stay DISTINCT in the data — they mean
// different things for reporting and for the lookup pipeline — but they are one
// switch to an operator, whose question is only ever "may this number text
// people whose carrier we do not know?".
//
//   'Unknown'      looked up, carrier undetermined
//   'Unmapped'     looked up, raw string awaiting an admin mapping
//   'Unidentified' never looked up (no phone_lookups row at all)
export const UNKNOWN_CARRIER_BUCKETS = ["Unknown", "Unmapped", "Unidentified"] as const;

// The normalized carrier vocabulary. A CLOSED set, enforced in the database by
// `carrier_mappings_carrier_norm_check` — this const is the same list, and the
// guard asserts the two still agree so a widened constraint cannot leave the UI
// silently unable to express a policy for a new carrier.
export const CARRIER_NORMS = [
  "AT&T",
  "T-Mobile",
  "Verizon",
  "Other Mobile",
  "VoIP",
  "Unknown",
] as const;

// The carriers an operator toggles INDIVIDUALLY. 'Unknown' is excluded because
// it and its two data-only siblings ('Unmapped', 'Unidentified') are governed
// together by `provider_phones.allow_unknown_carrier` — one switch, because the
// operator's question is only ever "may this number text people whose carrier
// we do not know?". Offering 'Unknown' here as well would give two controls
// over overlapping populations, and the operator could not tell which won.
export const NAMED_CARRIERS = CARRIER_NORMS.filter(
  (c) => !(UNKNOWN_CARRIER_BUCKETS as readonly string[]).includes(c),
);

export interface CarrierPolicy {
  /** The stage's sending number. NULL ⇒ no policy can apply. */
  providerPhoneId: number | null;
  /** provider_phones.allow_unknown_carrier. */
  allowUnknownCarrier: boolean;
}

// The audience-narrowing predicate for one policy, to be ANDed into a query
// where `carrierCol` names the contact's carrier_norm column.
//
// Returns `TRUE` — a literal no-op — when no sending number is assigned, so
// callers can always include it and the SQL is unchanged for a numberless
// stage. When a number IS assigned the clause is still a no-op in practice
// until someone writes a row or flips the boolean, because the anti-join finds
// nothing and the unknown branch short-circuits.
//
// ⚠️ This composes with the CAMPAIGN-level carrier filter by AND, and the two
// are deliberately different things: the campaign filter is frozen into
// `campaign_audience_pool` at activation and describes WHO THE CAMPAIGN IS FOR;
// this one is evaluated live at materialization and describes WHAT THIS NUMBER
// MAY CARRY. A contact must satisfy BOTH. Neither widens the other — each can
// only ever narrow — so their order of application is irrelevant to the result.
export function carrierPolicyClause(
  policy: CarrierPolicy | undefined,
  orgId: string,
  carrierCol: SQL,
): SQL {
  if (!policy || policy.providerPhoneId == null) return sql`true`;

  // Excluded when a row for THIS (number, carrier) says allowed = false.
  const disallowed = sql`
    not exists (
      select 1 from phone_carrier_limits pcl
      where pcl.provider_phone_id = ${policy.providerPhoneId}::int
        and pcl.org_id = ${orgId}::uuid
        and pcl.carrier_norm = ${carrierCol}
        and pcl.allowed = false
    )
  `;

  if (policy.allowUnknownCarrier) return disallowed;

  // The boolean is off ⇒ additionally drop the three unknown-ish buckets. A
  // NULL carrier_norm is treated as unknown too: we cannot demonstrate the
  // carrier is permitted, and this switch says do not text those people.
  return sql`
    ${disallowed}
    and ${carrierCol} is not null
    and ${carrierCol} <> all (array['Unknown','Unmapped','Unidentified']::text[])
  `;
}

// Load a number's policy for the enforcement paths. Kept separate from the
// clause builder so callers can also REPORT what was excluded (the preflight
// breakdown does) without rebuilding the SQL.
export interface CarrierPolicyRow {
  carrier_norm: string;
  allowed: boolean;
  daily_limit: number | null;
}

// ── Q5: per-carrier DAILY CAP ────────────────────────────────────────────────
//
// `phone_carrier_limits.daily_limit` is the most messages this NUMBER may send
// to this CARRIER in one day. Four decisions are load-bearing:
//
// 1. THE DAY IS AN ET CALENDAR DAY, NOT A ROLLING 24 HOURS. A carrier cap is a
//    reputation/compliance instrument an operator reasons about as "per day",
//    and the org already anchors every campaign time to ET
//    (lib/campaign-timezone.ts). It therefore RESETS AT ET MIDNIGHT — it does
//    not decay gradually the way the existing `rate_24h` rolling ceiling does.
//    The two coexist and mean different things; do not merge them.
//
// 2. THE BOUNDARY IS PASSED AS A TIMESTAMPTZ RANGE, never as
//    `sent_at AT TIME ZONE 'America/New_York'`. A functional predicate on
//    sent_at cannot use stage_sends_phone_carrier_sent_day_idx (migration 0143)
//    and turns a once-per-batch check into a seq scan of a 1.4M-row table.
//
// 3. ENFORCED ONCE PER BATCH, AT THE BATCH BOUNDARY, as a SOFT stop — the same
//    shape as the `rate_minute` / `rate_24h` ceilings it sits beside. Rows stay
//    `pending`, nothing is latched, and the next tick resumes automatically
//    (immediately if another carrier is free, or after ET midnight if not).
//
// 4. MID-BATCH ACCOUNTING IS DELIBERATELY NOT BUILT, so the cap is a SOFT
//    CEILING WITH BOUNDED OVERSHOOT. Once a batch is claimed it is sent in
//    full; the count is not decremented per row. The overshoot is therefore at
//    most `batchSize - 1` messages beyond the limit for a given carrier (49
//    with the default batch size of 50), and only on the batch that crosses it.
//    Making it exact would mean re-counting per row inside the send loop — a
//    query per message on the hot path — for a guarantee a carrier cap does not
//    need. If an exact cap is ever required, that is the cost to accept, and it
//    should be a deliberate decision rather than a silent tightening here.

/** One carrier whose daily cap is already reached for a number. */
export interface CarrierCapBreach {
  carrier_norm: string;
  daily_limit: number;
  sent_today: number;
  /** Rows on this stage still waiting that would go to this carrier. */
  pending_rows: number;
}

/**
 * Carriers that are AT or OVER their daily cap for `providerPhoneId` right now,
 * counted over the current ET calendar day, and that STILL HAVE PENDING ROWS on
 * this stage.
 *
 * The pending-rows condition is what keeps the cap surgical: a cap reached on
 * VoIP must not stop a stage whose remaining recipients are all on Verizon.
 * Without it, one exhausted carrier would halt every send from the number for
 * the rest of the ET day.
 *
 * Returns [] when the number has no caps at all — the common case, and one
 * cheap indexed lookup on an empty child table.
 */
export async function findCarrierCapBreaches(
  dbc: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  opts: { orgId: string; providerPhoneId: number | null; stageId: number },
): Promise<CarrierCapBreach[]> {
  if (opts.providerPhoneId == null) return [];
  const rows = (await dbc.execute(sql`
    WITH day AS (
      -- ET midnight today and tomorrow, as timestamptz. Computed in SQL from
      -- now() so a long-running process cannot carry a stale day across the
      -- boundary, and expressed as a RANGE so the partial index applies.
      SELECT
        date_trunc('day', now() AT TIME ZONE ${CAMPAIGN_TIMEZONE}) AT TIME ZONE ${CAMPAIGN_TIMEZONE} AS day_start,
        (date_trunc('day', now() AT TIME ZONE ${CAMPAIGN_TIMEZONE}) + interval '1 day') AT TIME ZONE ${CAMPAIGN_TIMEZONE} AS day_end
    )
    SELECT pcl.carrier_norm,
           pcl.daily_limit,
           (
             SELECT count(*)::int FROM stage_sends ss, day
             WHERE ss.provider_phone_id = ${opts.providerPhoneId}
               AND ss.carrier_norm = pcl.carrier_norm
               AND ss.status = 'sent'
               AND ss.sent_at >= day.day_start
               AND ss.sent_at <  day.day_end
           ) AS sent_today,
           (
             SELECT count(*)::int FROM stage_sends p
             WHERE p.stage_id = ${opts.stageId}
               AND p.status = 'pending'
               AND p.carrier_norm = pcl.carrier_norm
           ) AS pending_rows
    FROM phone_carrier_limits pcl
    WHERE pcl.provider_phone_id = ${opts.providerPhoneId}
      AND pcl.org_id = ${opts.orgId}::uuid
      AND pcl.daily_limit IS NOT NULL
  `)) as unknown as CarrierCapBreach[];
  return rows
    .map((r) => ({
      carrier_norm: r.carrier_norm,
      daily_limit: Number(r.daily_limit),
      sent_today: Number(r.sent_today),
      pending_rows: Number(r.pending_rows),
    }))
    .filter((r) => r.sent_today >= r.daily_limit && r.pending_rows > 0);
}

/** Operator-facing one-liner for the drain's stop summary. */
export function describeCarrierCapBreaches(breaches: CarrierCapBreach[]): string {
  return breaches
    .map(
      (b) =>
        `${b.carrier_norm} ${b.sent_today}/${b.daily_limit} sent today (${CAMPAIGN_TIMEZONE_LABEL} calendar day), ` +
        `${b.pending_rows} row(s) still pending`,
    )
    .join("; ");
}
