import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { segments } from "@/db/schema";
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

// Segments no longer carry group membership (groups live on contacts now,
// applied via /api/contact-groups/* and the upload pipeline). This endpoint
// is a thin create-only route since the rules-based audience model arrived
// in 0029.
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

  try {
    const [created] = await db
      .insert(segments)
      .values({
        org_id: orgId,
        name: parsed.data.name,
        segment_id: parsed.data.segment_id,
        original_name: nullIfEmpty(parsed.data.original_name),
        status: "active",
      })
      .returning();
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
