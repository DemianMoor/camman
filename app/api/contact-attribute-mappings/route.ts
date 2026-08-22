import { and, asc, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { contact_attribute_import_mappings } from "@/db/schema";
import { apiError, isUniqueViolation, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { contactAttributeMappingCreateSchema } from "@/lib/validators/contact-attribute-mappings";

// Saved column → field mappings for attribute CSV imports (migration 0149).
// Mirrors the result_import_mappings endpoints, which do the same job for
// campaign-result CSVs.

export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "contacts.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const rows = await db
    .select()
    .from(contact_attribute_import_mappings)
    .where(eq(contact_attribute_import_mappings.org_id, orgId))
    // Default first so the picker can preselect it without a second pass.
    .orderBy(
      drizzleSql`${contact_attribute_import_mappings.is_default} DESC`,
      asc(contact_attribute_import_mappings.name),
    );

  return NextResponse.json({ data: rows });
}

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;
  // Same gate as uploading contacts — a mapping only matters to someone who can
  // run an import.
  if (!can(role, "contacts.upload")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = contactAttributeMappingCreateSchema.safeParse(json);
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
    // Clearing any existing default and inserting must be ONE transaction: the
    // partial unique index (one default per org) would otherwise reject the
    // insert if the clear had not committed, and a failed insert after a
    // committed clear would leave the org with no default at all.
    const row = await db.transaction(async (tx) => {
      if (input.is_default) {
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
      const inserted = await tx
        .insert(contact_attribute_import_mappings)
        .values({
          org_id: orgId,
          name: input.name,
          mapping: input.mapping,
          is_default: input.is_default ?? false,
          created_by: user.id,
        })
        .returning();
      return inserted[0];
    });
    return NextResponse.json(row, { status: 201 });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return apiError(
        409,
        "A mapping with that name already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "name" },
      );
    }
    throw e;
  }
}
