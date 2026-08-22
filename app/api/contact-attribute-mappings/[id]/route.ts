import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { contact_attribute_import_mappings } from "@/db/schema";
import { apiError, isUniqueViolation, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { contactAttributeMappingUpdateSchema } from "@/lib/validators/contact-attribute-mappings";

function parseId(v: string) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "contacts.upload")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id: idParam } = await params;
  const id = parseId(idParam);
  if (id === null) {
    return apiError(400, "Invalid mapping id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = contactAttributeMappingUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
      { field: parsed.error.issues[0]?.path.join(".") },
    );
  }
  const input = parsed.data;

  try {
    const row = await db.transaction(async (tx) => {
      // Ownership inside the tx, so a concurrent delete cannot slip between the
      // check and the write.
      const existing = await tx
        .select({ id: contact_attribute_import_mappings.id })
        .from(contact_attribute_import_mappings)
        .where(
          and(
            eq(contact_attribute_import_mappings.id, id),
            eq(contact_attribute_import_mappings.org_id, orgId),
          ),
        )
        .limit(1);
      if (!existing[0]) return null;

      if (input.is_default === true) {
        // See the POST comment: clear + set must share a transaction or the
        // one-default-per-org partial unique index rejects the write.
        await tx
          .update(contact_attribute_import_mappings)
          .set({ is_default: false, updated_at: new Date() })
          .where(
            and(
              eq(contact_attribute_import_mappings.org_id, orgId),
              eq(contact_attribute_import_mappings.is_default, true),
            ),
          );
      }

      const updated = await tx
        .update(contact_attribute_import_mappings)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.mapping !== undefined ? { mapping: input.mapping } : {}),
          ...(input.is_default !== undefined ? { is_default: input.is_default } : {}),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(contact_attribute_import_mappings.id, id),
            eq(contact_attribute_import_mappings.org_id, orgId),
          ),
        )
        .returning();
      return updated[0];
    });

    if (!row) {
      return apiError(404, "Mapping not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "contact_attribute_import_mapping",
      });
    }
    return NextResponse.json(row);
  } catch (e) {
    if (isUniqueViolation(e)) {
      return apiError(409, "A mapping with that name already exists", API_ERROR_CODES.DUPLICATE, {
        field: "name",
      });
    }
    throw e;
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "contacts.upload")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id: idParam } = await params;
  const id = parseId(idParam);
  if (id === null) {
    return apiError(400, "Invalid mapping id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  // Hard delete: a saved mapping is a convenience, not a record of anything.
  // Deleting one destroys no import history — the attributes it wrote stay.
  const deleted = await db
    .delete(contact_attribute_import_mappings)
    .where(
      and(
        eq(contact_attribute_import_mappings.id, id),
        eq(contact_attribute_import_mappings.org_id, orgId),
      ),
    )
    .returning({ id: contact_attribute_import_mappings.id });

  if (!deleted[0]) {
    return apiError(404, "Mapping not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "contact_attribute_import_mapping",
    });
  }
  return NextResponse.json({ deleted: deleted[0].id });
}
