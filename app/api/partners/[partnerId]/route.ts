import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { partners } from "@/db/schema";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { loadPartner } from "@/lib/partners/queries";
import { can } from "@/lib/permissions";
import { partnerUpdateSchema } from "@/lib/validators/partners";

// One partner (0200): detail with its keys, and the two mutable fields —
// name and the revenue toggle. The slug is immutable (stamped onto leads).
export const dynamic = "force-dynamic";

function parseId(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ partnerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "partner_keys.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const id = parseId((await params).partnerId);
  if (id === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "partnerId" });

  const partner = await loadPartner(orgId, id);
  if (!partner) return apiError(404, "Partner not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner" });
  return NextResponse.json(partner);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ partnerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "partner_keys.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const id = parseId((await params).partnerId);
  if (id === null) return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "partnerId" });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = partnerUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION, {
      field: parsed.error.issues[0]?.path.join("."),
    });
  }
  const input = parsed.data;

  const updated = await db
    .update(partners)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.report_show_revenue !== undefined
        ? { report_show_revenue: input.report_show_revenue }
        : {}),
    })
    .where(and(eq(partners.id, id), eq(partners.org_id, orgId)))
    .returning({ id: partners.id });
  if (!updated[0]) return apiError(404, "Partner not found", API_ERROR_CODES.NOT_FOUND, { entity: "partner" });

  return NextResponse.json(await loadPartner(orgId, id));
}

// No DELETE. partner_keys.partner_id is ON DELETE RESTRICT and the keys' leads
// carry the slug as provenance. Archive instead (POST …/archive): intake and
// the report link both read the partner's status.
