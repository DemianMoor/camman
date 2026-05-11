import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { offers } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { nullIfEmpty, offerCreateSchema } from "@/lib/validators/offers";

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "offers.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = offerCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const data = parsed.data;

  try {
    const [created] = await db
      .insert(offers)
      .values({
        org_id: orgId,
        offer_id: data.offer_id,
        name: data.name,
        postfix: nullIfEmpty(data.postfix),
        base_url: nullIfEmpty(data.base_url),
        network_id: data.network_id ?? null,
        payout_model: data.payout_model,
        payout_cpa:
          data.payout_model === "cpa" && data.payout_cpa != null
            ? String(data.payout_cpa)
            : null,
        payout_revshare:
          data.payout_model === "revshare" && data.payout_revshare != null
            ? String(data.payout_revshare)
            : null,
        sales_pages: data.sales_pages,
        avatar_url: nullIfEmpty(data.avatar_url),
        color: nullIfEmpty(data.color),
        status: "active",
      })
      .returning();
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "An offer with this offer_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "offer_id" },
      );
    }
    throw err;
  }
}
