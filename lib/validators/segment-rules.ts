import { z } from "zod";

import {
  getValueShapeForRuleType,
  isValidOperatorForRuleType,
  RULE_TYPE_KEYS,
  type ValueShape,
} from "./segment-rule-types";

// Per-value-shape validation. Used by the refinement to cross-check
// `value` against the resolved value_shape for the chosen rule_type.
function validateValueByShape(shape: ValueShape, value: unknown): boolean {
  switch (shape) {
    case "none":
      return value == null;
    case "positive_integer":
      return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 36500
      );
    case "brand_id":
    case "offer_id":
    case "segment_id":
    case "contact_group_id":
      return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1
      );
    default:
      return false;
  }
}

const baseRuleObject = z.object({
  rule_type: z.enum(RULE_TYPE_KEYS as [string, ...string[]]),
  operator: z.string(),
  // `value` is JSON-decoded; runtime shape varies per rule type. We
  // post-validate it via the refinement below.
  value: z.unknown().optional(),
  is_active: z.boolean().default(true),
});

export const segmentRuleCreateSchema = baseRuleObject
  .refine((d) => isValidOperatorForRuleType(d.rule_type, d.operator), {
    message: "Invalid operator for this rule type",
    path: ["operator"],
  })
  .refine(
    (d) => {
      const shape = getValueShapeForRuleType(d.rule_type);
      if (!shape) return false;
      return validateValueByShape(shape, d.value);
    },
    { message: "Invalid value for this rule type", path: ["value"] },
  );

// Partial update. Refinement is conditional: if either rule_type or
// operator/value is in the patch, we re-check consistency against the
// patch + existing-row merged state. The route handler does the merge.
export const segmentRuleUpdateSchema = z
  .object({
    rule_type: z
      .enum(RULE_TYPE_KEYS as [string, ...string[]])
      .optional(),
    operator: z.string().optional(),
    value: z.unknown().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export const segmentRulesReorderSchema = z.object({
  rule_ids: z.array(z.number().int().positive()).min(1),
});

export type SegmentRuleCreateInput = z.infer<typeof segmentRuleCreateSchema>;
export type SegmentRuleUpdateInput = z.infer<typeof segmentRuleUpdateSchema>;
export type SegmentRulesReorderInput = z.infer<
  typeof segmentRulesReorderSchema
>;

// Shared helper used by both schema (above) and the PATCH route's
// merged-state validation. Returns null on success, an error message
// on failure.
export function validateMergedRuleShape(
  ruleType: string,
  operator: string,
  value: unknown,
): string | null {
  if (!isValidOperatorForRuleType(ruleType, operator)) {
    return "Invalid operator for this rule type";
  }
  const shape = getValueShapeForRuleType(ruleType);
  if (!shape) return "Unknown rule type";
  if (!validateValueByShape(shape, value)) {
    return "Invalid value for this rule type";
  }
  return null;
}
