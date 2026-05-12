import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  brands,
  clickers,
  offers,
  provider_phones,
  sms_providers,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import {
  processAudienceUpload,
  type ResolvedContact,
} from "@/lib/upload/audience-upload";
import { clickerUploadSchema } from "@/lib/validators/clickers";

const INSERT_CHUNK = 1000;

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "clickers.upload")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = clickerUploadSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Verify brand_id (required).
  const bRow = await db
    .select({ id: brands.id })
    .from(brands)
    .where(and(eq(brands.id, parsed.data.brand_id), eq(brands.org_id, orgId)))
    .limit(1);
  if (!bRow[0]) {
    return apiError(
      400,
      "brand_id doesn't belong to your organization",
      API_ERROR_CODES.VALIDATION,
      { field: "brand_id" },
    );
  }

  // Verify optional FKs.
  if (parsed.data.provider_id != null) {
    const r = await db
      .select({ id: sms_providers.id })
      .from(sms_providers)
      .where(
        and(
          eq(sms_providers.id, parsed.data.provider_id),
          eq(sms_providers.org_id, orgId),
        ),
      )
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "provider_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "provider_id" },
      );
    }
  }
  if (parsed.data.provider_phone_id != null) {
    const r = await db
      .select({ id: provider_phones.id })
      .from(provider_phones)
      .where(
        and(
          eq(provider_phones.id, parsed.data.provider_phone_id),
          eq(provider_phones.org_id, orgId),
        ),
      )
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "provider_phone_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "provider_phone_id" },
      );
    }
  }
  if (parsed.data.offer_id != null) {
    const r = await db
      .select({ id: offers.id })
      .from(offers)
      .where(
        and(eq(offers.id, parsed.data.offer_id), eq(offers.org_id, orgId)),
      )
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "offer_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "offer_id" },
      );
    }
  }

  const summary = await processAudienceUpload({
    orgId,
    rawPhones: parsed.data.phones,
    insertEntities: async (rows: ResolvedContact[]) => {
      if (rows.length === 0) return 0;
      return await db.transaction(async (tx) => {
        let total = 0;
        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
          const chunk = rows.slice(i, i + INSERT_CHUNK);
          const ins = await tx
            .insert(clickers)
            .values(
              chunk.map((r) => ({
                org_id: orgId,
                contact_id: r.contact_id,
                phone_number: r.phone_number,
                brand_id: parsed.data.brand_id,
                provider_id: parsed.data.provider_id ?? null,
                provider_phone_id: parsed.data.provider_phone_id ?? null,
                offer_id: parsed.data.offer_id ?? null,
                source: parsed.data.source ?? null,
              })),
            )
            .returning({ id: clickers.id });
          total += ins.length;
        }
        return total;
      });
    },
  });

  return NextResponse.json(summary, { status: 201 });
}
