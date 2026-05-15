import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { segment_stats, segments } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import {
  nullIfEmpty,
  segmentUpdateSchema,
} from "@/lib/validators/segments";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const NULLABLE_OPTIONAL_STRING = new Set(["original_name"]);
// Segments no longer carry group membership — groups live on contacts now
// (see contact_contact_groups). The detail payload no longer includes a
// `segment_groups` aggregation; the audience picker/rule editor surfaces
// group membership separately when relevant.
const ROW_FIELDS = new Set([
  "name",
  "segment_id",
  "original_name",
  "exclude_in_use_contacts",
]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segments.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const segmentId = parseId(id);
  if (segmentId === null) {
    return apiError(400, "Invalid segment id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select({
      id: segments.id,
      segment_id: segments.segment_id,
      org_id: segments.org_id,
      name: segments.name,
      original_name: segments.original_name,
      status: segments.status,
      archived_at: segments.archived_at,
      created_at: segments.created_at,
      exclude_in_use_contacts: segments.exclude_in_use_contacts,
      stats: {
        total_count: segment_stats.total_count,
        opt_out_count: segment_stats.opt_out_count,
        opt_in_count: segment_stats.opt_in_count,
        clicker_count: segment_stats.clicker_count,
        rule_filtered_count: segment_stats.rule_filtered_count,
        updated_at: segment_stats.updated_at,
      },
      active_rules_count: drizzleSql<number>`(
        select count(*)::int from segment_rules
        where segment_rules.segment_id = ${segments.id}
          and segment_rules.is_active = true
      )`,
    })
    .from(segments)
    .leftJoin(segment_stats, eq(segments.id, segment_stats.segment_id))
    .where(and(eq(segments.id, segmentId), eq(segments.org_id, orgId)))
    .limit(1);

  if (!rows[0]) {
    return apiError(404, "Segment not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "segment",
    });
  }
  const row = rows[0];
  return NextResponse.json({
    ...row,
    stats: row.stats ?? {
      total_count: 0,
      opt_out_count: 0,
      opt_in_count: 0,
      clicker_count: 0,
      rule_filtered_count: null,
      updated_at: null,
    },
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segments.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const segmentId = parseId(id);
  if (segmentId === null) {
    return apiError(400, "Invalid segment id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = segmentUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    if (!ROW_FIELDS.has(k)) continue;
    updates[k] = NULLABLE_OPTIONAL_STRING.has(k) ? nullIfEmpty(v as string) : v;
  }
  if (Object.keys(updates).length === 0) {
    return apiError(
      400,
      "At least one field must be provided",
      API_ERROR_CODES.VALIDATION,
    );
  }

  try {
    const updated = await db
      .update(segments)
      .set(updates)
      .where(and(eq(segments.id, segmentId), eq(segments.org_id, orgId)))
      .returning();

    if (!updated[0]) {
      return apiError(404, "Segment not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "segment",
      });
    }
    return NextResponse.json(updated[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A segment with this segment_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "segment_id" },
      );
    }
    throw err;
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segments.delete")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const segmentId = parseId(id);
  if (segmentId === null) {
    return apiError(400, "Invalid segment id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const deleted = await db.transaction(async (tx) => {
    return await tx
      .delete(segments)
      .where(and(eq(segments.id, segmentId), eq(segments.org_id, orgId)))
      .returning({ id: segments.id });
  });

  if (deleted.length === 0) {
    return apiError(404, "Segment not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "segment",
    });
  }
  return NextResponse.json({ deleted: true, id: segmentId });
}
