import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, opt_ins, sms_providers } from "@/db/schema";
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
  if (!can(role, "opt_ins.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const oid = parseId(id);
  if (oid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select({
      id: opt_ins.id,
      org_id: opt_ins.org_id,
      contact_id: opt_ins.contact_id,
      phone_number: opt_ins.phone_number,
      brand_id: opt_ins.brand_id,
      provider_id: opt_ins.provider_id,
      source: opt_ins.source,
      created_at: opt_ins.created_at,
      brand: { id: brands.id, name: brands.name, color: brands.color },
      provider: {
        id: sms_providers.id,
        name: sms_providers.name,
        color: sms_providers.color,
      },
    })
    .from(opt_ins)
    .leftJoin(brands, eq(brands.id, opt_ins.brand_id))
    .leftJoin(sms_providers, eq(sms_providers.id, opt_ins.provider_id))
    .where(and(eq(opt_ins.id, oid), eq(opt_ins.org_id, orgId)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return apiError(404, "Opt-in not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "opt_in",
    });
  }
  return NextResponse.json({
    ...row,
    brand: row.brand && row.brand.id !== null ? row.brand : null,
    provider: row.provider && row.provider.id !== null ? row.provider : null,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "opt_ins.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const oid = parseId(id);
  if (oid === null) {
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
    .update(opt_ins)
    .set({ source: body.source ?? null })
    .where(and(eq(opt_ins.id, oid), eq(opt_ins.org_id, orgId)))
    .returning();

  if (!updated[0]) {
    return apiError(404, "Opt-in not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "opt_in",
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
  if (!can(role, "opt_ins.delete")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const oid = parseId(id);
  if (oid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const deleted = await db
    .delete(opt_ins)
    .where(and(eq(opt_ins.id, oid), eq(opt_ins.org_id, orgId)))
    .returning({ id: opt_ins.id });

  if (!deleted[0]) {
    return apiError(404, "Opt-in not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "opt_in",
    });
  }
  return NextResponse.json({ ok: true, id: deleted[0].id });
}
