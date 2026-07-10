import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// Org-scoped base-mix aggregate over contacts: counts by line_type, carrier_norm,
// and messaging_status. Single DB round-trip (grouped by all three, reduced in JS).
// Permission: contacts.view.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contacts.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const rows = await db
    .select({
      line_type: contacts.line_type,
      carrier_norm: contacts.carrier_norm,
      messaging_status: contacts.messaging_status,
      count: sql<number>`count(*)::int`,
    })
    .from(contacts)
    .where(eq(contacts.org_id, orgId))
    .groupBy(
      contacts.line_type,
      contacts.carrier_norm,
      contacts.messaging_status,
    );

  let total = 0;
  const by_line_type: Record<string, number> = {};
  const by_carrier_norm: Record<string, number> = {};
  const by_messaging_status = { eligible: 0, not_applicable: 0 };

  for (const row of rows) {
    const n = row.count;
    total += n;
    by_line_type[row.line_type] = (by_line_type[row.line_type] ?? 0) + n;
    by_carrier_norm[row.carrier_norm] =
      (by_carrier_norm[row.carrier_norm] ?? 0) + n;
    if (row.messaging_status === "not_applicable") {
      by_messaging_status.not_applicable += n;
    } else {
      by_messaging_status.eligible += n;
    }
  }

  return NextResponse.json({
    total,
    by_line_type,
    by_carrier_norm,
    by_messaging_status,
  });
}
