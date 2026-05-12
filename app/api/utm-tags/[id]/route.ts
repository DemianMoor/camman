import { and, eq } from "drizzle-orm";
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
import { nullIfEmpty, utmTagUpdateSchema } from "@/lib/validators/utm-tags";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const NULLABLE_OPTIONAL_STRING = new Set(["color"]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "utm_tags.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const tid = parseId(id);
  if (tid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select()
    .from(utm_tags)
    .where(and(eq(utm_tags.id, tid), eq(utm_tags.org_id, orgId)))
    .limit(1);

  if (!rows[0]) {
    return apiError(404, "UTM tag not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "utm_tag",
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

  if (!can(role, "utm_tags.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const tid = parseId(id);
  if (tid === null) {
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

  const parsed = utmTagUpdateSchema.safeParse(json);
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
    if (NULLABLE_OPTIONAL_STRING.has(k)) {
      updates[k] = nullIfEmpty(v as string);
    } else if (k === "affiliate_network_id") {
      updates[k] = v ?? null;
    } else {
      updates[k] = v;
    }
  }

  try {
    const updated = await db
      .update(utm_tags)
      .set(updates)
      .where(and(eq(utm_tags.id, tid), eq(utm_tags.org_id, orgId)))
      .returning();

    if (!updated[0]) {
      return apiError(404, "UTM tag not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "utm_tag",
      });
    }
    return NextResponse.json(updated[0]);
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
