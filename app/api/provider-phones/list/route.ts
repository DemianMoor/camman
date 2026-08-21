import { and, asc, eq, isNull, or } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { provider_phones, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// Org-wide list of ACTIVE provider phones across all providers, labeled by
// provider. Powers the campaign form's "Default send-from number" picker
// (there is no campaign-level provider, so this crosses providers by design).
export async function GET(request: Request) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_phones.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const sp = new URL(request.url).searchParams;

  // Opt-in: the segment-rules editor needs archived numbers so a rule
  // referencing one still renders its label instead of going blank.
  const includeArchived = sp.get("include_archived") === "1";

  // Brand → numbers (Drip Phase 1, item 1a). When set, return only numbers
  // usable by that brand: the brand's own numbers PLUS any number with no
  // brand (shared — see lib/api/brand-number-guard.ts, "ABSENT = ALLOWED").
  // Omitted ⇒ org-wide, byte-identical to the pre-1a response, which is what
  // the segment-rules editor still needs (it labels rules across every brand).
  const brandParam = sp.get("brand_id");
  const brandFilter =
    brandParam != null && /^\d+$/.test(brandParam) ? Number(brandParam) : null;

  const rows = await db
    .select({
      id: provider_phones.id,
      brand_id: provider_phones.brand_id,
      phone_number: provider_phones.phone_number,
      number_type: provider_phones.number_type,
      status: provider_phones.status,
      provider_id: sms_providers.id,
      provider_name: sms_providers.name,
      provider_key: sms_providers.sms_provider_id,
      provider_color: sms_providers.color,
      supports_api_send: sms_providers.supports_api_send,
    })
    .from(provider_phones)
    .innerJoin(
      sms_providers,
      and(
        eq(sms_providers.id, provider_phones.provider_id),
        eq(sms_providers.org_id, orgId),
      ),
    )
    .where(
      and(
        eq(provider_phones.org_id, orgId),
        includeArchived ? undefined : eq(provider_phones.status, "active"),
        // brand's own numbers OR shared (NULL brand). Zero-width when unset.
        brandFilter !== null
          ? or(
              eq(provider_phones.brand_id, brandFilter),
              isNull(provider_phones.brand_id),
            )
          : undefined,
      ),
    )
    .orderBy(asc(sms_providers.name), asc(provider_phones.phone_number));

  return NextResponse.json({ data: rows });
}
