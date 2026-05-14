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
  | "contact_group_id";

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
