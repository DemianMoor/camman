import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { campaign_audience_pool, campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
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
  const { include_no_status, include_clickers, exclude_clickers } =
    parsed.data;

  // Single CTE-driven aggregate: join pool to a live opt-outs presence
  // flag, then count with FILTERs for each breakdown slice.
  //
  //   match  = NOT opt_out_now
  //            AND ((no_status AND inc_ns) OR (clicker AND inc_cl))
  //            AND NOT (clicker AND excl_cl)
  //
  // The breakdown counts use the same opt-out exclusion but ignore the
  // include/exclude toggles so the UI can show "what if I changed this."
  const rows = (await db.execute(drizzleSql`
    with joined as (
      select
        p.contact_id,
        p.was_clicker_at_snapshot,
        p.was_no_status_at_snapshot,
        exists (
          select 1 from opt_outs oo
          where oo.contact_id = p.contact_id and oo.org_id = ${orgId}::uuid
        ) as is_opt_out_now
      from campaign_audience_pool p
      where p.campaign_id = ${cid}::int
    )
    select
      count(*) filter (
        where not is_opt_out_now
          and (
            (${include_no_status}::boolean and was_no_status_at_snapshot)
            or (${include_clickers}::boolean and was_clicker_at_snapshot)
          )
          and not (${exclude_clickers}::boolean and was_clicker_at_snapshot)
      )::int as count,
      count(*) filter (
        where not is_opt_out_now and was_no_status_at_snapshot
      )::int as no_status,
      count(*) filter (
        where not is_opt_out_now and was_clicker_at_snapshot
      )::int as clickers,
      count(*) filter (where is_opt_out_now)::int as excluded_for_optout
    from joined
  `)) as unknown as {
    count: number;
    no_status: number;
    clickers: number;
    excluded_for_optout: number;
  }[];

  const row = rows[0] ?? {
    count: 0,
    no_status: 0,
    clickers: 0,
    excluded_for_optout: 0,
  };

  return NextResponse.json({
    count: row.count,
    breakdown: {
      no_status: row.no_status,
      clickers: row.clickers,
      excluded_for_optout: row.excluded_for_optout,
    },
    pool_size: campaignRow[0].audience_snapshot_count,
  });
}
