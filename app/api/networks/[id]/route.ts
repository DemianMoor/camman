import { and, eq } from "drizzle-orm";
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
import { networkUpdateSchema, nullIfEmpty } from "@/lib/validators/networks";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const NULLABLE_OPTIONAL_STRING = new Set(["url", "avatar_url", "color"]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "networks.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const networkId = parseId(id);
  if (networkId === null) {
    return apiError(400, "Invalid network id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select()
    .from(affiliate_networks)
    .where(
      and(
        eq(affiliate_networks.id, networkId),
        eq(affiliate_networks.org_id, orgId),
      ),
    )
    .limit(1);

  if (!rows[0]) {
    return apiError(404, "Network not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "network",
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

  if (!can(role, "networks.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const networkId = parseId(id);
  if (networkId === null) {
    return apiError(400, "Invalid network id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = networkUpdateSchema.safeParse(json);
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
      .update(affiliate_networks)
      .set(updates)
      .where(
        and(
          eq(affiliate_networks.id, networkId),
          eq(affiliate_networks.org_id, orgId),
        ),
      )
      .returning();

    if (!updated[0]) {
      return apiError(404, "Network not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "network",
      });
    }
    return NextResponse.json(updated[0]);
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
