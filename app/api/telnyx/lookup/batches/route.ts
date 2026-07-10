import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { lookup_batches } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// List the 50 most recent lookup batches for the caller's org. Permission: operator+.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "lookup.run")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const rows = await db
    .select({
      id: lookup_batches.id,
      trigger: lookup_batches.trigger,
      total_numbers: lookup_batches.total_numbers,
      cache_hits: lookup_batches.cache_hits,
      processed: lookup_batches.processed,
      failed: lookup_batches.failed,
      est_cost_usd: lookup_batches.est_cost_usd,
      actual_cost_usd: lookup_batches.actual_cost_usd,
      balance_before_usd: lookup_batches.balance_before_usd,
      balance_after_usd: lookup_batches.balance_after_usd,
      status: lookup_batches.status,
      created_at: lookup_batches.created_at,
    })
    .from(lookup_batches)
    .where(eq(lookup_batches.org_id, orgId))
    .orderBy(desc(lookup_batches.created_at))
    .limit(50);

  return NextResponse.json({ data: rows });
}
