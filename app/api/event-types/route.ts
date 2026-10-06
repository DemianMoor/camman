import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { event_types } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// The org's active event types, for the conversion-mapping pickers on the
// Affiliate Networks page. Gated on networks.view because that page is its
// only consumer.
export async function GET() {
  const auth = await requireApiMembership({
    route: "event-types",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "networks.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const rows = await db
    .select({ id: event_types.id, key: event_types.key, label: event_types.label })
    .from(event_types)
    .where(and(eq(event_types.org_id, orgId), eq(event_types.status, "active")))
    .orderBy(asc(event_types.display_order), asc(event_types.id));

  return NextResponse.json({ data: rows });
}
