import { and, asc, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  brands,
  contact_groups,
  offers,
  segment_rules,
  segments,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { verifyValueOwnership } from "@/lib/api/segment-rule-value-ownership";
import { getValueShapeForRuleType } from "@/lib/validators/segment-rule-types";
import { segmentRuleCreateSchema } from "@/lib/validators/segment-rules";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Verify the parent segment belongs to this org. Returns the segment id
// on success, null on miss.
async function assertSegmentOwnership(
  segmentId: number,
  orgId: string,
): Promise<boolean> {
  const r = await db
    .select({ id: segments.id })
    .from(segments)
    .where(and(eq(segments.id, segmentId), eq(segments.org_id, orgId)))
    .limit(1);
  return r.length > 0;
}

// Hydrate a rule with the referenced entity's basic info for UI display.
// Returns `{ ...rule, ref: { id, name, color } | null }` per row.
type RuleRow = {
  id: number;
  segment_id: number;
  rule_type: string;
  operator: string;
  value: unknown;
  position: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

async function hydrateRefs(rows: RuleRow[], orgId: string) {
  const brandIds = new Set<number>();
  const offerIds = new Set<number>();
  const segmentIds = new Set<number>();
  const contactGroupIds = new Set<number>();
  for (const r of rows) {
    const shape = getValueShapeForRuleType(r.rule_type);
    if (typeof r.value !== "number") continue;
    if (shape === "brand_id") brandIds.add(r.value);
    else if (shape === "offer_id") offerIds.add(r.value);
    else if (shape === "segment_id") segmentIds.add(r.value);
    else if (shape === "contact_group_id") contactGroupIds.add(r.value);
  }
  type Info = { id: number; name: string; color: string | null };
  const brandMap = new Map<number, Info>();
  const offerMap = new Map<number, Info>();
  const segmentMap = new Map<number, Info>();
  const contactGroupMap = new Map<number, Info>();
  if (brandIds.size > 0) {
    const b = await db
      .select({ id: brands.id, name: brands.name, color: brands.color })
      .from(brands)
      .where(
        and(
          eq(brands.org_id, orgId),
          drizzleSql`${brands.id} = ANY (ARRAY[${drizzleSql.raw(Array.from(brandIds).join(","))}]::int[])`,
        ),
      );
    for (const row of b) brandMap.set(row.id, row);
  }
  if (offerIds.size > 0) {
    const o = await db
      .select({ id: offers.id, name: offers.name, color: offers.color })
      .from(offers)
      .where(
        and(
          eq(offers.org_id, orgId),
          drizzleSql`${offers.id} = ANY (ARRAY[${drizzleSql.raw(Array.from(offerIds).join(","))}]::int[])`,
        ),
      );
    for (const row of o) offerMap.set(row.id, row);
  }
  if (segmentIds.size > 0) {
    const s = await db
      .select({ id: segments.id, name: segments.name })
      .from(segments)
      .where(
        and(
          eq(segments.org_id, orgId),
          drizzleSql`${segments.id} = ANY (ARRAY[${drizzleSql.raw(Array.from(segmentIds).join(","))}]::int[])`,
        ),
      );
    // Segments don't have a color column; pad to the shared Info shape.
    for (const row of s) segmentMap.set(row.id, { ...row, color: null });
  }
  if (contactGroupIds.size > 0) {
    const g = await db
      .select({
        id: contact_groups.id,
        name: contact_groups.name,
        color: contact_groups.color,
      })
      .from(contact_groups)
      .where(
        and(
          eq(contact_groups.org_id, orgId),
          drizzleSql`${contact_groups.id} = ANY (ARRAY[${drizzleSql.raw(Array.from(contactGroupIds).join(","))}]::int[])`,
        ),
      );
    for (const row of g) contactGroupMap.set(row.id, row);
  }
  return rows.map((r) => {
    const shape = getValueShapeForRuleType(r.rule_type);
    let ref: Info | null = null;
    if (typeof r.value === "number") {
      if (shape === "brand_id") ref = brandMap.get(r.value) ?? null;
      else if (shape === "offer_id") ref = offerMap.get(r.value) ?? null;
      else if (shape === "segment_id") ref = segmentMap.get(r.value) ?? null;
      else if (shape === "contact_group_id")
        ref = contactGroupMap.get(r.value) ?? null;
    }
    return { ...r, ref };
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segment_rules.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const segmentId = parseId(id);
  if (segmentId === null) {
    return apiError(400, "Invalid segment id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }
  if (!(await assertSegmentOwnership(segmentId, orgId))) {
    return apiError(404, "Segment not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "segment",
    });
  }

  const rows = await db
    .select()
    .from(segment_rules)
    .where(
      and(
        eq(segment_rules.segment_id, segmentId),
        eq(segment_rules.org_id, orgId),
      ),
    )
    .orderBy(asc(segment_rules.position));

  const hydrated = await hydrateRefs(rows as RuleRow[], orgId);
  return NextResponse.json({ data: hydrated });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segment_rules.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const segmentId = parseId(id);
  if (segmentId === null) {
    return apiError(400, "Invalid segment id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }
  if (!(await assertSegmentOwnership(segmentId, orgId))) {
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
  const parsed = segmentRuleCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const input = parsed.data;

  const ownership = await verifyValueOwnership(
    orgId,
    input.rule_type,
    input.value,
    segmentId,
  );
  if (!ownership.ok) {
    return apiError(400, ownership.reason, API_ERROR_CODES.VALIDATION, {
      field: "value",
    });
  }

  // Position auto-assigned as MAX(position) + 1 inside a transaction so
  // concurrent creates don't collide. (No UNIQUE constraint, so worst case
  // is duplicate positions which the reorder endpoint renumbers.)
  const created = await db.transaction(async (tx) => {
    const maxRow = (await tx.execute(drizzleSql`
      SELECT COALESCE(MAX(position), 0) AS max_pos
      FROM segment_rules
      WHERE segment_id = ${segmentId}::int AND org_id = ${orgId}::uuid
    `)) as unknown as { max_pos: number }[];
    const nextPos = (maxRow[0]?.max_pos ?? 0) + 1;
    const [row] = await tx
      .insert(segment_rules)
      .values({
        org_id: orgId,
        segment_id: segmentId,
        rule_type: input.rule_type,
        operator: input.operator,
        value: (input.value as Record<string, unknown>) ?? null,
        position: nextPos,
        is_active: input.is_active,
      })
      .returning();
    return row;
  });

  const [hydrated] = await hydrateRefs([created as RuleRow], orgId);
  return NextResponse.json(hydrated, { status: 201 });
}
