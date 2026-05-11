import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { affiliate_networks, offers } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { nullIfEmpty, offerUpdateSchema } from "@/lib/validators/offers";

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

  if (!can(role, "offers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const offerId = parseId(id);
  if (offerId === null) {
    return apiError(400, "Invalid offer id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select({
      id: offers.id,
      offer_id: offers.offer_id,
      org_id: offers.org_id,
      name: offers.name,
      postfix: offers.postfix,
      base_url: offers.base_url,
      network_id: offers.network_id,
      payout_model: offers.payout_model,
      payout_cpa: offers.payout_cpa,
      payout_revshare: offers.payout_revshare,
      sales_pages: offers.sales_pages,
      avatar_url: offers.avatar_url,
      color: offers.color,
      status: offers.status,
      archived_at: offers.archived_at,
      created_at: offers.created_at,
      network: {
        id: affiliate_networks.id,
        name: affiliate_networks.name,
        avatar_url: affiliate_networks.avatar_url,
        color: affiliate_networks.color,
      },
    })
    .from(offers)
    .leftJoin(affiliate_networks, eq(offers.network_id, affiliate_networks.id))
    .where(and(eq(offers.id, offerId), eq(offers.org_id, orgId)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return apiError(404, "Offer not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "offer",
    });
  }
  const out = {
    ...row,
    network: row.network && row.network.id !== null ? row.network : null,
  };
  return NextResponse.json(out);
}

const NULLABLE_OPTIONAL_STRING = new Set([
  "postfix",
  "base_url",
  "avatar_url",
  "color",
]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "offers.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const offerId = parseId(id);
  if (offerId === null) {
    return apiError(400, "Invalid offer id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = offerUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    if (NULLABLE_OPTIONAL_STRING.has(k)) {
      updates[k] = nullIfEmpty(v as string);
    } else if (k === "network_id") {
      updates[k] = v ?? null;
    } else if (k === "payout_cpa" || k === "payout_revshare") {
      // Drizzle accepts string for numeric columns; preserve precision.
      updates[k] = v == null ? null : String(v);
    } else {
      updates[k] = v;
    }
  }

  // If payout_model is being changed, clear the unused payout column so we don't
  // leave a stale value behind.
  if (typeof updates.payout_model === "string") {
    if (updates.payout_model === "cpa") {
      if (updates.payout_revshare === undefined) updates.payout_revshare = null;
    } else if (updates.payout_model === "revshare") {
      if (updates.payout_cpa === undefined) updates.payout_cpa = null;
    }
  }

  try {
    const updated = await db
      .update(offers)
      .set(updates)
      .where(and(eq(offers.id, offerId), eq(offers.org_id, orgId)))
      .returning();

    if (!updated[0]) {
      return apiError(404, "Offer not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "offer",
      });
    }
    return NextResponse.json(updated[0]);
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
