import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { utm_tags } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { nullIfEmpty, utmTagCreateSchema } from "@/lib/validators/utm-tags";

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "utm_tags.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = utmTagCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  try {
    const [created] = await db
      .insert(utm_tags)
      .values({
        org_id: orgId,
        label: parsed.data.label,
        tag_id: parsed.data.tag_id,
        value_source: parsed.data.value_source,
        affiliate_network_id: parsed.data.affiliate_network_id ?? null,
        color: nullIfEmpty(parsed.data.color),
        status: "active",
      })
      .returning();
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A UTM tag with this tag_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "tag_id" },
      );
    }
    throw err;
  }
}
