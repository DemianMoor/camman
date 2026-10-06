import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { conversion_event_mappings } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Deactivates a network rule (status = 'archived'). On the next Keitaro poll
// every conversion of that type in the 7-day live window turns unmapped — the
// UI confirms first. Re-adding a rule for the same type is a fresh POST.
export async function POST(
  _req: NextRequest,
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

  const updated = await db
    .update(conversion_event_mappings)
    .set({ status: "archived", archived_at: drizzleSql`now()` })
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
