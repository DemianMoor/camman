import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { segment_groups } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import {
  nullIfEmpty,
  segmentGroupUpdateSchema,
} from "@/lib/validators/segment-groups";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const NULLABLE_OPTIONAL_STRING = new Set(["description", "color"]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segment_groups.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const sid = parseId(id);
  if (sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select()
    .from(segment_groups)
    .where(and(eq(segment_groups.id, sid), eq(segment_groups.org_id, orgId)))
    .limit(1);

  if (!rows[0]) {
    return apiError(404, "Segment group not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "segment_group",
    });
  }
  return NextResponse.json(rows[0]);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "segment_groups.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const sid = parseId(id);
  if (sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = segmentGroupUpdateSchema.safeParse(json);
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
    updates[k] = NULLABLE_OPTIONAL_STRING.has(k) ? nullIfEmpty(v as string) : v;
  }

  try {
    const updated = await db
      .update(segment_groups)
      .set(updates)
      .where(and(eq(segment_groups.id, sid), eq(segment_groups.org_id, orgId)))
      .returning();

    if (!updated[0]) {
      return apiError(404, "Segment group not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "segment_group",
      });
    }
    return NextResponse.json(updated[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A segment group with this segment_group_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "segment_group_id" },
      );
    }
    throw err;
  }
}
