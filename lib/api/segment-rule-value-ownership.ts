import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { brands, contact_groups, offers, segments } from "@/db/schema";
import { getValueShapeForRuleType } from "@/lib/validators/segment-rule-types";

// Result of a value-ownership check. Routes turn `{ ok: false }` into a
// 400 response with the carried reason and `field: "value"`.
export type OwnershipResult =
  | { ok: true }
  | { ok: false; reason: string };

// Shared verifier for the FK references inside a segment rule's `value`.
//
// - For value_shape `none` / `positive_integer`: no FK to check; returns ok.
// - For brand_id / offer_id / segment_id / contact_group_id: confirms the
//   referenced row exists in the caller's org.
// - For `member_of_segment` specifically: also rejects self-reference when
//   currentSegmentId is provided and equals the value.
//
// Both the POST and PATCH rule routes call this. The PATCH route's local
// copy used to drift (it was missing `contact_group_id`); centralizing here
// keeps them in lockstep.
export async function verifyValueOwnership(
  orgId: string,
  ruleType: string,
  value: unknown,
  currentSegmentId: number | null,
): Promise<OwnershipResult> {
  const shape = getValueShapeForRuleType(ruleType);
  if (!shape || shape === "none" || shape === "positive_integer") {
    return { ok: true };
  }
  // FK shapes accept null — an "incomplete" rule that the eval skips. The
  // validator allows this too; nothing to check ownership of.
  if (value == null) {
    return { ok: true };
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    // Validator's refinement should already have rejected this; defense in
    // depth in case a future caller bypasses the Zod parse.
    return { ok: false, reason: "Value must be a positive integer" };
  }

  switch (shape) {
    case "brand_id": {
      const r = await db
        .select({ id: brands.id })
        .from(brands)
        .where(and(eq(brands.id, value), eq(brands.org_id, orgId)))
        .limit(1);
      if (!r[0]) {
        return {
          ok: false,
          reason: "Referenced brand doesn't belong to your organization",
        };
      }
      return { ok: true };
    }
    case "offer_id": {
      const r = await db
        .select({ id: offers.id })
        .from(offers)
        .where(and(eq(offers.id, value), eq(offers.org_id, orgId)))
        .limit(1);
      if (!r[0]) {
        return {
          ok: false,
          reason: "Referenced offer doesn't belong to your organization",
        };
      }
      return { ok: true };
    }
    case "segment_id": {
      if (currentSegmentId !== null && value === currentSegmentId) {
        return {
          ok: false,
          reason: "A segment rule can't reference its own segment",
        };
      }
      const r = await db
        .select({ id: segments.id })
        .from(segments)
        .where(and(eq(segments.id, value), eq(segments.org_id, orgId)))
        .limit(1);
      if (!r[0]) {
        return {
          ok: false,
          reason: "Referenced segment doesn't belong to your organization",
        };
      }
      return { ok: true };
    }
    case "contact_group_id": {
      const r = await db
        .select({ id: contact_groups.id })
        .from(contact_groups)
        .where(
          and(eq(contact_groups.id, value), eq(contact_groups.org_id, orgId)),
        )
        .limit(1);
      if (!r[0]) {
        return {
          ok: false,
          reason: "Referenced contact group doesn't belong to your organization",
        };
      }
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}
