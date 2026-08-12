// Single source of truth for valid segment-rule type ↔ operator ↔ value
// combinations. Both the Zod validators (server-side) and the rule editor
// (client-side) read from this map.

export const OPERATORS = ["is", "is_not"] as const;
export type Operator = (typeof OPERATORS)[number];

export type ValueShape =
  | "none"
  | "positive_integer"
  | "brand_id"
  | "offer_id"
  | "segment_id"
  | "contact_group_id"
  | "campaign_use_period"
  | "phone_type_set"
  | "carrier_set"
  | "provider_phone_set";

// Value sets for the carrier/line-type rules (migration 0098). Stored in the
// rule's `value` as a non-empty array of these codes. 'landline' is intentionally
// absent from phone_type (landlines are not_applicable, absent from segments).
// Carrier offers BOTH Unknown and Unidentified (segments are grouping tools):
// Unknown matches ('Unknown','Unmapped'); Unidentified matches only itself.
export const PHONE_TYPE_VALUES = ["mobile", "voip", "toll_free", "unknown"] as const;
export type PhoneTypeValue = (typeof PHONE_TYPE_VALUES)[number];
export const CARRIER_VALUES = [
  "AT&T",
  "T-Mobile",
  "Verizon",
  "Other Mobile",
  "VoIP",
  "Unknown",
  "Unidentified",
] as const;
export type CarrierValue = (typeof CARRIER_VALUES)[number];

export function isStringSubsetOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
): v is T[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => typeof x === "string" && (allowed as readonly string[]).includes(x)) &&
    new Set(v).size === v.length
  );
}

// Value for `sent_from_provider_phone`: a set of provider_phones ids scoped to
// one provider. provider_id is redundant with the phones (each belongs to
// exactly one provider) but is persisted so the editor can hold a provider
// while the user is mid-pick, and so ownership checks can assert both.
export type ProviderPhoneSet = { provider_id: number; phone_ids: number[] };

// int4 max — both sms_providers.id and provider_phones.id are `serial`
// (postgres int4). Without a ceiling, Number.isInteger(1e21) is true and
// String(1e21) renders "1e+21", which is invalid inside ARRAY[...]::int[].
const INT4_MAX = 2147483647;

export function isProviderPhoneSet(v: unknown): v is ProviderPhoneSet {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2) return false;
  if (!keys.includes("provider_id") || !keys.includes("phone_ids")) return false;
  const pid = o.provider_id;
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid < 1 ||
    pid > INT4_MAX
  ) {
    return false;
  }
  const ids = o.phone_ids;
  if (!Array.isArray(ids) || ids.length === 0) return false;
  if (
    !ids.every(
      (x) => typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= INT4_MAX,
    )
  ) {
    return false;
  }
  return new Set(ids).size === ids.length;
}

// Fixed set of lookback windows for the "in use in another campaign" rule.
// Stored in the rule's `value` as the code string (e.g. "1w"). The code →
// SQL interval mapping lives server-side in lib/segment-rules-eval.ts so the
// only thing crossing the wire / persisted is the opaque code.
export const CAMPAIGN_USE_PERIODS = [
  { code: "1d", label: "1 day" },
  { code: "3d", label: "3 days" },
  { code: "1w", label: "1 week" },
  { code: "2w", label: "2 weeks" },
  { code: "1m", label: "1 month" },
  { code: "3m", label: "3 months" },
  { code: "6m", label: "6 months" },
  { code: "1y", label: "1 year" },
] as const;

export type CampaignUsePeriod = (typeof CAMPAIGN_USE_PERIODS)[number]["code"];

export const CAMPAIGN_USE_PERIOD_CODES = CAMPAIGN_USE_PERIODS.map(
  (p) => p.code,
) as CampaignUsePeriod[];

export function isCampaignUsePeriod(v: unknown): v is CampaignUsePeriod {
  return (
    typeof v === "string" &&
    (CAMPAIGN_USE_PERIOD_CODES as readonly string[]).includes(v)
  );
}

interface RuleTypeSpec {
  label: string;
  operators: readonly Operator[];
  value_shape: ValueShape;
}

export const RULE_TYPES = {
  // === Engagement ===
  is_clicker_any_brand: {
    label: "Is a clicker (any brand)",
    operators: ["is", "is_not"],
    value_shape: "none",
  },
  is_clicker_for_brand: {
    label: "Is a clicker for specific brand",
    operators: ["is", "is_not"],
    value_shape: "brand_id",
  },
  is_clicker_for_offer: {
    label: "Is a clicker for specific offer",
    operators: ["is", "is_not"],
    value_shape: "offer_id",
  },
  // Purchase (sale) rules — mirror the clicker scoping (any / brand / offer).
  // A contact "made a purchase" when they have ≥1 stage_sends row with
  // sale_status='sale' (NOT 'lead' or 'rejected'). Empty org-wide until real
  // sales accumulate. See lib/segment-rules-eval.ts.
  made_purchase: {
    label: "Made a purchase (any)",
    operators: ["is", "is_not"],
    value_shape: "none",
  },
  made_purchase_for_brand: {
    label: "Made a purchase for specific brand",
    operators: ["is", "is_not"],
    value_shape: "brand_id",
  },
  made_purchase_for_offer: {
    label: "Made a purchase for specific offer",
    operators: ["is", "is_not"],
    value_shape: "offer_id",
  },
  // Offer-page reach (Level 2) — mirror the clicker/purchase scoping. A contact
  // "reached the offer page" when they have ≥1 stage_sends row with
  // offer_reached_at IS NOT NULL (an OFFER-campaign click, not the landing
  // gk-lp-visits campaign). Empty org-wide until real sends accumulate. See
  // lib/segment-rules-eval.ts.
  reached_offer: {
    label: "Reached the offer page (any)",
    operators: ["is", "is_not"],
    value_shape: "none",
  },
  reached_offer_for_brand: {
    label: "Reached the offer page for specific brand",
    operators: ["is", "is_not"],
    value_shape: "brand_id",
  },
  reached_offer_for_offer: {
    label: "Reached the offer page for specific offer",
    operators: ["is", "is_not"],
    value_shape: "offer_id",
  },
  is_optin_any_brand: {
    label: "Has opted in (any brand)",
    operators: ["is", "is_not"],
    value_shape: "none",
  },
  is_optin_for_brand: {
    label: "Has opted in for specific brand",
    operators: ["is", "is_not"],
    value_shape: "brand_id",
  },
  is_optout_for_brand: {
    label: "Is opted out for specific brand",
    operators: ["is", "is_not"],
    value_shape: "brand_id",
  },

  // === Time-based ===
  // The operator on these is implicit (the rule type itself encodes the
  // direction); we still require operator="is" for schema uniformity.
  contact_added_in_last_n_days: {
    label: "Added to platform in last N days",
    operators: ["is"],
    value_shape: "positive_integer",
  },
  contact_added_more_than_n_days_ago: {
    label: "Added to platform more than N days ago",
    operators: ["is"],
    value_shape: "positive_integer",
  },
  joined_segment_in_last_n_days: {
    label: "Joined this segment in last N days",
    operators: ["is"],
    value_shape: "positive_integer",
  },
  joined_segment_more_than_n_days_ago: {
    label: "Joined this segment more than N days ago",
    operators: ["is"],
    value_shape: "positive_integer",
  },

  // === Campaign usage ===
  // "In use in another campaign in the last <period>". A contact counts as
  // in-use when it sits in a campaign_audience_pool for a campaign that ran
  // (status active/paused/completed) within the window AND still has at
  // least one live stage (draft/pending/sent/success) — a campaign whose
  // stages are all cancelled/failed releases its contacts. The window
  // anchors on campaigns.created_at. See lib/segment-rules-eval.ts.
  in_use_in_campaign_last_period: {
    label: "In use in another campaign in the last…",
    operators: ["is", "is_not"],
    value_shape: "campaign_use_period",
  },
  // "In use in a specific offer". A contact counts as in-use when it sits in
  // a campaign_audience_pool for a campaign whose offer is the selected one,
  // where the campaign ran (status active/paused/completed) AND still has at
  // least one live stage (draft/pending/sent/success). Archived campaigns and
  // campaigns whose stages are all cancelled/failed/archived have released
  // their audience and do NOT count. Same live-campaign definition as
  // in_use_in_campaign_last_period, minus the time window. See
  // lib/segment-rules-eval.ts.
  in_use_in_offer: {
    label: "In use in a specific offer",
    operators: ["is", "is_not"],
    value_shape: "offer_id",
  },

  // === Cross-segment ===
  member_of_segment: {
    label: "Is a member of another segment",
    operators: ["is", "is_not"],
    value_shape: "segment_id",
  },

  // === Contact tags ===
  is_in_contact_group: {
    label: "Is in contact group",
    operators: ["is", "is_not"],
    value_shape: "contact_group_id",
  },

  // === Carrier / line type (migration 0098) ===
  // Evaluate against the denormalized, eligible-partial-indexed contact columns.
  // phone_type is IN-only (a chosen set of line types); carrier is IN / NOT IN.
  phone_type: {
    label: "Phone type is one of",
    operators: ["is"],
    value_shape: "phone_type_set",
  },
  carrier: {
    label: "Carrier is one of",
    operators: ["is", "is_not"],
    value_shape: "carrier_set",
  },

  // === Send provenance ===
  // Which of OUR sending numbers messaged the contact. Distinct from the
  // contact-side phone_type / carrier rules above, which describe the
  // RECIPIENT's number — hence the "Sent from" label.
  sent_from_provider_phone: {
    label: "Sent from phone number",
    operators: ["is", "is_not"],
    value_shape: "provider_phone_set",
  },
} as const satisfies Record<string, RuleTypeSpec>;

export type RuleType = keyof typeof RULE_TYPES;

export const RULE_TYPE_KEYS = Object.keys(RULE_TYPES) as RuleType[];

export function isRuleType(s: string): s is RuleType {
  return s in RULE_TYPES;
}

export function isValidOperatorForRuleType(
  ruleType: string,
  operator: string,
): boolean {
  if (!isRuleType(ruleType)) return false;
  return (RULE_TYPES[ruleType].operators as readonly string[]).includes(
    operator,
  );
}

export function getValueShapeForRuleType(ruleType: string): ValueShape | null {
  if (!isRuleType(ruleType)) return null;
  return RULE_TYPES[ruleType].value_shape;
}

export function getRuleTypeLabel(ruleType: string): string {
  if (!isRuleType(ruleType)) return ruleType;
  return RULE_TYPES[ruleType].label;
}
