import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { segment_rules, segments } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { segmentRulesReorderSchema } from "@/lib/validators/segment-rules";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Reassigns position to match the order of `rule_ids`. Body validates the
// caller sent every rule_id that belongs to this segment, in the order
// they want them ordered. Done in a single transaction with positions
// renumbered 1..N atomically.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segment_rules.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const segmentId = parseId(id);
  if (segmentId === null) {
    return apiError(400, "Invalid segment id", API_ERROR_CODES.VALIDATION);
  }

  // Verify the parent segment belongs to this org.
  const segR = await db
    .select({ id: segments.id })
    .from(segments)
    .where(and(eq(segments.id, segmentId), eq(segments.org_id, orgId)))
    .limit(1);
  if (!segR[0]) {
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
  const parsed = segmentRulesReorderSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const ruleIds = parsed.data.rule_ids;

  // Verify every id belongs to this segment and we have ALL of them (no
  // missing, no extras) — otherwise the partial reorder would leave
  // some rows with stale positions.
  const existing = await db
    .select({ id: segment_rules.id })
    .from(segment_rules)
    .where(
      and(
        eq(segment_rules.segment_id, segmentId),
        eq(segment_rules.org_id, orgId),
      ),
    );
  const existingIds = new Set(existing.map((r) => r.id));
  if (existingIds.size !== ruleIds.length) {
    return apiError(
      400,
      "Reorder payload must include every rule belonging to this segment",
      API_ERROR_CODES.VALIDATION,
      {
        provided: ruleIds.length,
        expected: existingIds.size,
      },
    );
  }
  for (const id of ruleIds) {
    if (!existingIds.has(id)) {
      return apiError(
        400,
        `Rule ${id} doesn't belong to this segment`,
        API_ERROR_CODES.VALIDATION,
      );
    }
  }

  // Renumber in one transaction. To avoid colliding with the existing
  // positions (no UNIQUE constraint but still — keep things tidy) we
  // first shove everything to negative positions, then assign the
  // real ones.
  await db.transaction(async (tx) => {
    await tx
      .update(segment_rules)
      .set({ position: -1 })
      .where(
        and(
          eq(segment_rules.segment_id, segmentId),
          eq(segment_rules.org_id, orgId),
          inArray(segment_rules.id, ruleIds),
        ),
      );
    for (let i = 0; i < ruleIds.length; i++) {
      await tx
        .update(segment_rules)
        .set({ position: i + 1 })
        .where(
          and(
            eq(segment_rules.id, ruleIds[i]),
            eq(segment_rules.segment_id, segmentId),
            eq(segment_rules.org_id, orgId),
          ),
        );
    }
  });

  return NextResponse.json({ ok: true });
}
