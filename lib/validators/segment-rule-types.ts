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
  | "campaign_use_period";

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
