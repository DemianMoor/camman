import { and, asc, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { result_import_mappings, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "import_mappings.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const providerParam = req.nextUrl.searchParams.get("provider_id");
  const providerId = providerParam ? Number(providerParam) : null;
  if (providerParam !== null && (!Number.isInteger(providerId) || providerId! <= 0)) {
    return apiError(400, "Invalid provider_id", API_ERROR_CODES.VALIDATION, {
      field: "provider_id",
    });
  }

  const conditions = [eq(result_import_mappings.org_id, orgId)];
  if (providerId !== null) {
    conditions.push(eq(result_import_mappings.sms_provider_id, providerId));
  }

  const rows = await db
    .select({
      id: result_import_mappings.id,
      sms_provider_id: result_import_mappings.sms_provider_id,
      name: result_import_mappings.name,
      is_default: result_import_mappings.is_default,
      mapping: result_import_mappings.mapping,
      status_value_map: result_import_mappings.status_value_map,
      created_at: result_import_mappings.created_at,
      updated_at: result_import_mappings.updated_at,
      provider: {
        id: sms_providers.id,
        name: sms_providers.name,
        color: sms_providers.color,
      },
    })
    .from(result_import_mappings)
    .leftJoin(
      sms_providers,
      eq(sms_providers.id, result_import_mappings.sms_provider_id),
    )
    .where(and(...conditions))
    .orderBy(asc(result_import_mappings.name));

  return NextResponse.json({ data: rows, totalCount: rows.length });
}
