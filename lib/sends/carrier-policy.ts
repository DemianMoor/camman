import { sql, type SQL } from "drizzle-orm";

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
