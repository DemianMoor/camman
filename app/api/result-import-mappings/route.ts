import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { result_import_mappings, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { mappingCreateSchema } from "@/lib/validators/result-import-mappings";

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "import_mappings.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = mappingCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const input = parsed.data;

  // Verify the provider is in the org.
  const provider = await db
    .select({ id: sms_providers.id })
    .from(sms_providers)
    .where(
      and(
        eq(sms_providers.id, input.sms_provider_id),
        eq(sms_providers.org_id, orgId),
      ),
    )
    .limit(1);
  if (!provider[0]) {
    return apiError(
      400,
      "sms_provider_id doesn't belong to your organization",
      API_ERROR_CODES.VALIDATION,
      { field: "sms_provider_id" },
    );
  }

  // If is_default=true, clear the existing default for this provider in the
  // same transaction so the partial-unique index never fires.
  try {
    const result = await db.transaction(async (tx) => {
      if (input.is_default) {
        await tx
          .update(result_import_mappings)
          .set({ is_default: false, updated_at: drizzleSql`now()` })
          .where(
            and(
              eq(result_import_mappings.org_id, orgId),
              eq(
                result_import_mappings.sms_provider_id,
                input.sms_provider_id,
              ),
              eq(result_import_mappings.is_default, true),
            ),
          );
      }
      const [row] = await tx
        .insert(result_import_mappings)
        .values({
          org_id: orgId,
          sms_provider_id: input.sms_provider_id,
          name: input.name,
          is_default: input.is_default,
          mapping: input.mapping,
          status_value_map: input.status_value_map ?? null,
        })
        .returning();
      return row;
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    // Defense in depth — should not fire given the in-tx clear above.
    return apiError(
      500,
      err instanceof Error ? err.message : "Failed to create mapping",
      API_ERROR_CODES.INTERNAL,
    );
  }
}
