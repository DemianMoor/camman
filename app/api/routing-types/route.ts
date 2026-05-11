import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { routing_types } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import {
  nullIfEmpty,
  routingTypeCreateSchema,
} from "@/lib/validators/routing-types";

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "routing_types.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = routingTypeCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  try {
    const [created] = await db
      .insert(routing_types)
      .values({
        org_id: orgId,
        name: parsed.data.name,
        routing_type_id: parsed.data.routing_type_id,
        description: nullIfEmpty(parsed.data.description),
        color: nullIfEmpty(parsed.data.color),
        status: "active",
      })
      .returning();
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A routing type with this routing_type_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "routing_type_id" },
      );
    }
    throw err;
  }
}
