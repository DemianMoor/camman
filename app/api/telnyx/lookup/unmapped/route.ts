import { desc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { phone_lookups } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// Global (cross-org) tally of raw carrier strings still sitting at 'Unmapped',
// so an admin can assign each to a bucket. The phone_lookups cache is account-global
// (no org_id). Permission: manager+.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { role } = auth;

  if (!can(role, "lookup.admin")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const rows = await db
    .select({
      carrier_raw: phone_lookups.carrier_raw,
      count: sql<number>`count(*)::int`,
    })
    .from(phone_lookups)
    .where(eq(phone_lookups.carrier_norm, "Unmapped"))
    .groupBy(phone_lookups.carrier_raw)
    .orderBy(desc(sql`count(*)`));

  return NextResponse.json({ data: rows });
}
