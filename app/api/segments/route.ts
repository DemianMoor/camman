import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  segment_groups,
  segment_segment_groups,
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
  segmentCreateSchema,
} from "@/lib/validators/segments";

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segments.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = segmentCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const groupIds = Array.from(new Set(parsed.data.segment_group_ids ?? []));
  if (groupIds.length > 0) {
    const rows = await db
      .select({ id: segment_groups.id })
      .from(segment_groups)
      .where(
        and(
          eq(segment_groups.org_id, orgId),
          inArray(segment_groups.id, groupIds),
        ),
      );
    if (rows.length !== groupIds.length) {
      return apiError(
        400,
        "One or more segment_group_ids do not belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "segment_group_ids" },
      );
    }
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [seg] = await tx
        .insert(segments)
        .values({
          org_id: orgId,
          name: parsed.data.name,
          segment_id: parsed.data.segment_id,
          original_name: nullIfEmpty(parsed.data.original_name),
          status: "active",
        })
        .returning();
      if (groupIds.length > 0) {
        await tx.insert(segment_segment_groups).values(
          groupIds.map((gid) => ({
            segment_id: seg.id,
            segment_group_id: gid,
            org_id: orgId,
          })),
        );
      }
      return seg;
    });
    return NextResponse.json(created, { status: 201 });
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
