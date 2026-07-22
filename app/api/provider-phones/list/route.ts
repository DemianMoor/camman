import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { provider_phones, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// Org-wide list of ACTIVE provider phones across all providers, labeled by
// provider. Powers the campaign form's "Default send-from number" picker
// (there is no campaign-level provider, so this crosses providers by design).
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_phones.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const rows = await db
    .select({
      id: provider_phones.id,
      phone_number: provider_phones.phone_number,
      number_type: provider_phones.number_type,
      provider_id: sms_providers.id,
      provider_name: sms_providers.name,
      provider_key: sms_providers.sms_provider_id,
      provider_color: sms_providers.color,
      supports_api_send: sms_providers.supports_api_send,
    })
    .from(provider_phones)
    .innerJoin(sms_providers, eq(sms_providers.id, provider_phones.provider_id))
    .where(
      and(
        eq(provider_phones.org_id, orgId),
        eq(provider_phones.status, "active"),
      ),
    )
    .orderBy(asc(sms_providers.name), asc(provider_phones.phone_number));

  return NextResponse.json({ data: rows });
}
