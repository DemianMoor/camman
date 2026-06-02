import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { creatives } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { buildCreativeListWhere } from "@/lib/creatives/list-filters";
import { can } from "@/lib/permissions";

// Hard ceiling on how many ids we'll hand back for a single
// select-all-across-filter action. Well above any realistic creative
// count for one org; protects against an unbounded response.
const MAX_IDS = 10_000;

// Returns every creative id matching the SAME filter the list endpoint
// uses (no pagination). Powers "select all N matching this filter" in the
// bulk-edit UI. Read-only; gated on creatives.view like the list.
export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "creatives.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const params = parseListParams(req);
  const where = buildCreativeListWhere({
    orgId,
    search: params.search,
    showArchived: params.showArchived,
    searchParams: req.nextUrl.searchParams,
  });

  const rows = await db
    .select({ id: creatives.id })
    .from(creatives)
    .where(where)
    .orderBy(creatives.created_at)
    .limit(MAX_IDS);

  return NextResponse.json({
    ids: rows.map((r) => r.id),
    truncated: rows.length >= MAX_IDS,
  });
}
