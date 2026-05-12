import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { result_import_mappings } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Atomically promote this mapping to default for its (org, provider),
// clearing the prior default in the same transaction.
export async function POST(
  _req: NextRequest,
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

  const updated = await db.transaction(async (tx) => {
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
    const [row] = await tx
      .update(result_import_mappings)
      .set({ is_default: true, updated_at: drizzleSql`now()` })
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
}
