import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { segment_rules, segments } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { verifyValueOwnership } from "@/lib/api/segment-rule-value-ownership";
import {
  segmentRuleUpdateSchema,
  validateMergedRuleShape,
} from "@/lib/validators/segment-rules";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

async function loadRule(
  ruleId: number,
  segmentId: number,
  orgId: string,
) {
  const rows = await db
    .select()
    .from(segment_rules)
    .where(
      and(
        eq(segment_rules.id, ruleId),
        eq(segment_rules.segment_id, segmentId),
        eq(segment_rules.org_id, orgId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function assertSegment(segmentId: number, orgId: string) {
  const r = await db
    .select({ id: segments.id })
    .from(segments)
    .where(and(eq(segments.id, segmentId), eq(segments.org_id, orgId)))
    .limit(1);
  return r.length > 0;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; ruleId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segment_rules.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id, ruleId } = await params;
  const segmentId = parseId(id);
  const rid = parseId(ruleId);
  if (segmentId === null || rid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }
  if (!(await assertSegment(segmentId, orgId))) {
    return apiError(404, "Segment not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "segment",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = segmentRuleUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const patch = parsed.data;

  const existing = await loadRule(rid, segmentId, orgId);
  if (!existing) {
    return apiError(404, "Rule not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "rule",
    });
  }

  // Merge patch with existing for cross-field validation.
  const mergedRuleType = patch.rule_type ?? existing.rule_type;
  const mergedOperator = patch.operator ?? existing.operator;
  // If `value` is in the patch at all (even as null/undefined), it overrides.
  // For a value-shape-changing rule_type swap, we require the caller to
  // also send the new value. Easiest enforcement: re-validate the merged
  // shape regardless.
  const mergedValue =
    "value" in patch ? patch.value : existing.value;

  if (
    patch.rule_type !== undefined ||
    patch.operator !== undefined ||
    "value" in patch
  ) {
    const err = validateMergedRuleShape(
      mergedRuleType,
      mergedOperator,
      mergedValue,
    );
    if (err) {
      return apiError(400, err, API_ERROR_CODES.VALIDATION);
    }
    const ownership = await verifyValueOwnership(
      orgId,
      mergedRuleType,
      mergedValue,
      segmentId,
    );
    if (!ownership.ok) {
      return apiError(400, ownership.reason, API_ERROR_CODES.VALIDATION, {
        field: "value",
      });
    }
  }

  const updates: Record<string, unknown> = {
    updated_at: drizzleSql`now()`,
  };
  if (patch.rule_type !== undefined) updates.rule_type = patch.rule_type;
  if (patch.operator !== undefined) updates.operator = patch.operator;
  if ("value" in patch) updates.value = patch.value ?? null;
  if (patch.is_active !== undefined) updates.is_active = patch.is_active;

  const [updated] = await db
    .update(segment_rules)
    .set(updates)
    .where(
      and(
        eq(segment_rules.id, rid),
        eq(segment_rules.segment_id, segmentId),
        eq(segment_rules.org_id, orgId),
      ),
    )
    .returning();
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; ruleId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segment_rules.delete")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id, ruleId } = await params;
  const segmentId = parseId(id);
  const rid = parseId(ruleId);
  if (segmentId === null || rid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const [deleted] = await db
    .delete(segment_rules)
    .where(
      and(
        eq(segment_rules.id, rid),
        eq(segment_rules.segment_id, segmentId),
        eq(segment_rules.org_id, orgId),
      ),
    )
    .returning({ id: segment_rules.id });
  if (!deleted) {
    return apiError(404, "Rule not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "rule",
    });
  }
  return NextResponse.json({ ok: true });
}
