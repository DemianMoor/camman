import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { computeStageAudienceCount } from "@/lib/audience-snapshot";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const previewSchema = z
  .object({
    include_no_status: z.boolean().default(true),
    include_clickers: z.boolean().default(false),
    exclude_clickers: z.boolean().default(false),
  })
  .refine((d) => !(d.include_clickers && d.exclude_clickers), {
    path: ["include_clickers"],
    message: "include_clickers and exclude_clickers can't both be true",
  });

// Stage audience preview. The pool is frozen at campaign activation; this
// endpoint applies the stage-level filter toggles on top of that pool and
// always excludes contacts who are in opt_outs RIGHT NOW (not just at
// snapshot time). Returns the count plus a small breakdown for UI.
//
// TODO 7.2e: extend the "clickers" filter to also include contacts who
// have been recorded as clickers via CSV results imports against prior
// stages of THIS campaign. Currently uses snapshot booleans only.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
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

  // Confirm the campaign is in this org. Also pulls the pool count so we
  // can return a consistent "out of N frozen" framing in the UI.
  const campaignRow = await db
    .select({
      id: campaigns.id,
      audience_snapshot_count: campaigns.audience_snapshot_count,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, cid), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!campaignRow[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "campaign",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = previewSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const result = await computeStageAudienceCount(cid, orgId, parsed.data);

  return NextResponse.json({
    count: result.count,
    breakdown: result.breakdown,
    pool_size: campaignRow[0].audience_snapshot_count,
  });
}
