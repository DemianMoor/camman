import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  segment_groups,
  segment_segment_groups,
  segment_stats,
  segments,
} from "@/db/schema";
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
// Fields stored on the segments row directly (excludes group membership,
// which lives in the junction and is handled separately).
const ROW_FIELDS = new Set(["name", "segment_id", "original_name"]);

// JSON aggregation of joined groups for a single segment. Returns
// `[{id, name, color}, …]` or `[]` if no groups. Uses literal SQL aliases
// (not Drizzle ${column} interpolation) because the latter emits column
// names without a table prefix, which produces ambiguity when two tables
// in scope share column names.
const groupsAggSql = drizzleSql<
  { id: number; name: string; color: string | null }[]
>`(
  select coalesce(json_agg(json_build_object(
    'id', sg."id",
    'name', sg."name",
    'color', sg."color"
  ) order by sg."name"), '[]'::json)
  from "segment_segment_groups" ssg
  inner join "segment_groups" sg
    on sg."id" = ssg."segment_group_id"
  where ssg."segment_id" = "segments"."id"
)`;

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
      segment_groups: groupsAggSql,
      stats: {
        total_count: segment_stats.total_count,
        opt_out_count: segment_stats.opt_out_count,
        opt_in_count: segment_stats.opt_in_count,
        clicker_count: segment_stats.clicker_count,
        updated_at: segment_stats.updated_at,
      },
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

  const groupIds =
    parsed.data.segment_group_ids !== undefined
      ? Array.from(new Set(parsed.data.segment_group_ids))
      : null; // null = don't touch groups
  if (groupIds && groupIds.length > 0) {
    const valid = await db
      .select({ id: segment_groups.id })
      .from(segment_groups)
      .where(
        and(
          eq(segment_groups.org_id, orgId),
          inArray(segment_groups.id, groupIds),
        ),
      );
    if (valid.length !== groupIds.length) {
      return apiError(
        400,
        "One or more segment_group_ids do not belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "segment_group_ids" },
      );
    }
  }

  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    if (!ROW_FIELDS.has(k)) continue;
    updates[k] = NULLABLE_OPTIONAL_STRING.has(k) ? nullIfEmpty(v as string) : v;
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Verify segment exists in this org.
      const segRow = await tx
        .select({ id: segments.id })
        .from(segments)
        .where(and(eq(segments.id, segmentId), eq(segments.org_id, orgId)))
        .limit(1);
      if (!segRow[0]) return null;

      if (Object.keys(updates).length > 0) {
        await tx
          .update(segments)
          .set(updates)
          .where(and(eq(segments.id, segmentId), eq(segments.org_id, orgId)));
      }

      if (groupIds !== null) {
        await tx
          .delete(segment_segment_groups)
          .where(eq(segment_segment_groups.segment_id, segmentId));
        if (groupIds.length > 0) {
          await tx.insert(segment_segment_groups).values(
            groupIds.map((gid) => ({
              segment_id: segmentId,
              segment_group_id: gid,
              org_id: orgId,
            })),
          );
        }
      }

      const [updated] = await tx
        .select()
        .from(segments)
        .where(and(eq(segments.id, segmentId), eq(segments.org_id, orgId)))
        .limit(1);
      return updated;
    });

    if (!result) {
      return apiError(404, "Segment not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "segment",
      });
    }
    return NextResponse.json(result);
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
