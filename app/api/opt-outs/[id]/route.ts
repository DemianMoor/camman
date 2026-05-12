import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  brands,
  opt_out_brands,
  opt_out_providers,
  opt_outs,
  sms_providers,
} from "@/db/schema";
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
  if (!can(role, "opt_outs.view")) {
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
    .select()
    .from(opt_outs)
    .where(and(eq(opt_outs.id, oid), eq(opt_outs.org_id, orgId)))
    .limit(1);

  if (!rows[0]) {
    return apiError(404, "Opt-out not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "opt_out",
    });
  }

  const [brandJoin, providerJoin] = await Promise.all([
    db
      .select({
        id: brands.id,
        name: brands.name,
        color: brands.color,
      })
      .from(opt_out_brands)
      .innerJoin(brands, eq(brands.id, opt_out_brands.brand_id))
      .where(eq(opt_out_brands.opt_out_id, oid)),
    db
      .select({
        id: sms_providers.id,
        name: sms_providers.name,
        color: sms_providers.color,
      })
      .from(opt_out_providers)
      .innerJoin(
        sms_providers,
        eq(sms_providers.id, opt_out_providers.provider_id),
      )
      .where(eq(opt_out_providers.opt_out_id, oid)),
  ]);

  return NextResponse.json({
    ...rows[0],
    brands: brandJoin,
    providers: providerJoin,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "opt_outs.update")) {
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
    .update(opt_outs)
    .set({ source: body.source ?? null })
    .where(and(eq(opt_outs.id, oid), eq(opt_outs.org_id, orgId)))
    .returning();

  if (!updated[0]) {
    return apiError(404, "Opt-out not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "opt_out",
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
  if (!can(role, "opt_outs.delete")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const oid = parseId(id);
  if (oid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  // FK CASCADE on opt_out_brands/opt_out_providers cleans junctions.
  const deleted = await db
    .delete(opt_outs)
    .where(and(eq(opt_outs.id, oid), eq(opt_outs.org_id, orgId)))
    .returning({ id: opt_outs.id });

  if (!deleted[0]) {
    return apiError(404, "Opt-out not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "opt_out",
    });
  }
  return NextResponse.json({ ok: true, id: deleted[0].id });
}
