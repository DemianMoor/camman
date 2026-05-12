import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { result_import_mappings } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { mappingUpdateSchema } from "@/lib/validators/result-import-mappings";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "import_mappings.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const mid = parseId(id);
  if (mid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const rows = await db
    .select()
    .from(result_import_mappings)
    .where(
      and(
        eq(result_import_mappings.id, mid),
        eq(result_import_mappings.org_id, orgId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    return apiError(404, "Mapping not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "import_mapping",
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

  if (!can(role, "import_mappings.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const mid = parseId(id);
  if (mid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = mappingUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const input = parsed.data;

  // Need the existing row to read sms_provider_id for the is_default clear.
  const existing = await db
    .select({
      id: result_import_mappings.id,
      sms_provider_id: result_import_mappings.sms_provider_id,
    })
    .from(result_import_mappings)
    .where(
      and(
        eq(result_import_mappings.id, mid),
        eq(result_import_mappings.org_id, orgId),
      ),
    )
    .limit(1);
  if (!existing[0]) {
    return apiError(404, "Mapping not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "import_mapping",
    });
  }

  try {
    const updated = await db.transaction(async (tx) => {
      if (input.is_default === true) {
        // Clear previous default for the same (org, provider).
        await tx
          .update(result_import_mappings)
          .set({ is_default: false, updated_at: drizzleSql`now()` })
          .where(
            and(
              eq(result_import_mappings.org_id, orgId),
              eq(
                result_import_mappings.sms_provider_id,
                existing[0].sms_provider_id,
              ),
              eq(result_import_mappings.is_default, true),
            ),
          );
      }
      const updates: Record<string, unknown> = { updated_at: drizzleSql`now()` };
      if (input.name !== undefined) updates.name = input.name;
      if (input.is_default !== undefined) updates.is_default = input.is_default;
      if (input.mapping !== undefined) updates.mapping = input.mapping;
      if (input.status_value_map !== undefined)
        updates.status_value_map = input.status_value_map ?? null;
      const [row] = await tx
        .update(result_import_mappings)
        .set(updates)
        .where(
          and(
            eq(result_import_mappings.id, mid),
            eq(result_import_mappings.org_id, orgId),
          ),
        )
        .returning();
      return row;
    });
    return NextResponse.json(updated);
  } catch (err) {
    return apiError(
      500,
      err instanceof Error ? err.message : "Failed to update mapping",
      API_ERROR_CODES.INTERNAL,
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "import_mappings.delete")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const mid = parseId(id);
  if (mid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const [deleted] = await db
    .delete(result_import_mappings)
    .where(
      and(
        eq(result_import_mappings.id, mid),
        eq(result_import_mappings.org_id, orgId),
      ),
    )
    .returning({ id: result_import_mappings.id });
  if (!deleted) {
    return apiError(404, "Mapping not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "import_mapping",
    });
  }
  return NextResponse.json({ ok: true });
}
