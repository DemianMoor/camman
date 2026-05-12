import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, clickers, offers, sms_providers } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

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
  if (!can(role, "clickers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const cid = parseId(id);
  if (cid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select({
      id: clickers.id,
      org_id: clickers.org_id,
      contact_id: clickers.contact_id,
      phone_number: clickers.phone_number,
      brand_id: clickers.brand_id,
      provider_id: clickers.provider_id,
      provider_phone_id: clickers.provider_phone_id,
      offer_id: clickers.offer_id,
      source: clickers.source,
      created_at: clickers.created_at,
      brand: { id: brands.id, name: brands.name, color: brands.color },
      provider: {
        id: sms_providers.id,
        name: sms_providers.name,
        color: sms_providers.color,
      },
      offer: { id: offers.id, name: offers.name, color: offers.color },
    })
    .from(clickers)
    .leftJoin(brands, eq(brands.id, clickers.brand_id))
    .leftJoin(sms_providers, eq(sms_providers.id, clickers.provider_id))
    .leftJoin(offers, eq(offers.id, clickers.offer_id))
    .where(and(eq(clickers.id, cid), eq(clickers.org_id, orgId)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return apiError(404, "Clicker not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "clicker",
    });
  }
  return NextResponse.json({
    ...row,
    brand: row.brand && row.brand.id !== null ? row.brand : null,
    provider: row.provider && row.provider.id !== null ? row.provider : null,
    offer: row.offer && row.offer.id !== null ? row.offer : null,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "clickers.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const cid = parseId(id);
  if (cid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const body = (json ?? {}) as { source?: string | null };
  if (typeof body.source === "undefined") {
    return apiError(
      400,
      "Nothing to update — only `source` is editable",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const updated = await db
    .update(clickers)
    .set({ source: body.source ?? null })
    .where(and(eq(clickers.id, cid), eq(clickers.org_id, orgId)))
    .returning();

  if (!updated[0]) {
    return apiError(404, "Clicker not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "clicker",
    });
  }
  return NextResponse.json(updated[0]);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "clickers.delete")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const cid = parseId(id);
  if (cid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const deleted = await db
    .delete(clickers)
    .where(and(eq(clickers.id, cid), eq(clickers.org_id, orgId)))
    .returning({ id: clickers.id });

  if (!deleted[0]) {
    return apiError(404, "Clicker not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "clicker",
    });
  }
  return NextResponse.json({ ok: true, id: deleted[0].id });
}
