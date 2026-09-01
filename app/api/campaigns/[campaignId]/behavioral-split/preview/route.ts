import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { previewSplitLanes } from "@/lib/stages/split-group";

// Provisional preview for the campaign-level behavioural-split confirm modal:
// the SOURCE SCOPE (which completed stages feed the classification) plus a live
// per-tier lane count.
//
// The numbers are PROVISIONAL and the UI says so — tier is read live, and the
// source set is re-derived at recompute time, so a stage that completes between
// now and T−15 legitimately widens it.
//
// Measured 1.0–3.5s on the widest production campaigns (the tier-1 links⋈clicks
// nested loop dominates, then the org-wide opt-out anti-join). 60s gives that
// comfortable headroom without being able to hang a serverless function.
export const maxDuration = 60;

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership({
    route: "campaigns/[campaignId]/behavioral-split/preview",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "stages.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId } = await params;
  const cid = parseId(campaignId);
  if (cid === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION, {
      field: "campaignId",
    });
  }

  // Ownership check — previewSplitLanes filters by org_id itself, but a 404 for a
  // missing/foreign campaign matches the rest of the campaign API's contract.
  const owned = (await db.execute(sql`
    SELECT 1 AS ok FROM campaigns WHERE id = ${cid}::int AND org_id = ${orgId}::uuid LIMIT 1
  `)) as unknown as { ok: number }[];
  if (!owned[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "campaign",
    });
  }

  const preview = await previewSplitLanes(db, cid, orgId);
  return NextResponse.json(preview);
}
