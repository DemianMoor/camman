import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { conversion_event_mappings } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { eventTypesBelongToOrg } from "@/lib/conversions/network-mappings";
import { can } from "@/lib/permissions";
import { mappingRuleUpdateSchema } from "@/lib/validators/conversion-mappings";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Edits an ACTIVE network rule's event type and/or status. The Keitaro type is
// not editable (that is a different rule). Takes effect on the next Keitaro
// poll for every conversion in its 7-day live window — the UI confirms first.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; mappingId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "networks.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id, mappingId } = await params;
  const networkId = parseId(id);
  const ruleId = parseId(mappingId);
  if (networkId === null || ruleId === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = mappingRuleUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  if (
    parsed.data.event_type_id !== undefined &&
    !(await eventTypesBelongToOrg(db, orgId, [parsed.data.event_type_id]))
  ) {
    return apiError(400, "Unknown event type", API_ERROR_CODES.VALIDATION, {
      field: "event_type_id",
    });
  }

  const updated = await db
    .update(conversion_event_mappings)
    .set({
      event_type_id: parsed.data.event_type_id,
      conversion_status: parsed.data.conversion_status,
    })
    .where(
      and(
        eq(conversion_event_mappings.id, ruleId),
        eq(conversion_event_mappings.org_id, orgId),
        eq(conversion_event_mappings.affiliate_network_id, networkId),
        eq(conversion_event_mappings.status, "active"),
      ),
    )
    .returning();

  if (!updated[0]) {
    return apiError(404, "Rule not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "conversion_mapping",
    });
  }
  return NextResponse.json(updated[0]);
}
