import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { affiliate_networks } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { networkCreateSchema, nullIfEmpty } from "@/lib/validators/networks";

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "networks.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = networkCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  try {
    const [created] = await db
      .insert(affiliate_networks)
      .values({
        org_id: orgId,
        name: parsed.data.name,
        network_id: parsed.data.network_id,
        url: nullIfEmpty(parsed.data.url),
        avatar_url: nullIfEmpty(parsed.data.avatar_url),
        color: nullIfEmpty(parsed.data.color),
        status: "active",
      })
      .returning();
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A network with this network_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "network_id" },
      );
    }
    throw err;
  }
}
