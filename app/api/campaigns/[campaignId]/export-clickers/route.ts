import { and, eq } from "drizzle-orm";
import { sql as drizzleSql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { campaign_stages, campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { chunkedQuery, streamCsvResponse } from "@/lib/csv/stream-export";
import { can } from "@/lib/permissions";
import { formatPhoneForExport } from "@/lib/phone-validation";

// Tracked-clicker export for a campaign. Joins clicks → links → contacts to
// return the contacts who actually clicked a tracked campaign's links, scoped
// to the campaign and optionally a single stage. One row per distinct contact
// (deduped by phone), with how many clicks they made and when they last clicked.
//
// This is the TRACKED-clicks dataset — distinct from /api/clickers/export,
// which exports the manually-imported `clickers` suppression/engagement table.
// It only applies to link_mode='tracked' campaigns (manual campaigns mint no
// links, so there are no tracked clicks to export).
//
// `include`:
//   * clean (default) — human only: scored_at IS NOT NULL AND classification =
//     'human'. Excludes bot/prefetch/suspect AND unscored rows. The scoring
//     exists precisely to separate real humans from prefetch noise, so the
//     default export honors it.
//   * all — every click row, regardless of classification or scored state.

// Streams a chunked, offset-paginated join over clicks→links→contacts; at scale
// this can outlast Vercel's default function budget and get killed mid-stream
// (silently truncated CSV). Match the other heavy routes' 60s ceiling.
export const maxDuration = 60;

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const querySchema = z.object({
  stage_id: z.coerce.number().int().positive().optional(),
  include: z.enum(["clean", "all"]).default("clean"),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  // Exporting is view-equivalent — same gate as export-phones.
  if (!can(role, "stages.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId } = await params;
  const cid = parseId(campaignId);
  if (cid === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION);
  }

  const parsedQuery = querySchema.safeParse({
    stage_id: req.nextUrl.searchParams.get("stage_id") ?? undefined,
    include: req.nextUrl.searchParams.get("include") ?? undefined,
  });
  if (!parsedQuery.success) {
    return apiError(
      400,
      parsedQuery.error.issues[0]?.message ?? "Invalid query",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const { stage_id: stageId, include } = parsedQuery.data;

  // Verify campaign ownership + grab the bits we need for the filename/guard.
  const campaignRows = await db
    .select({
      tracking_id: campaigns.tracking_id,
      link_mode: campaigns.link_mode,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, cid), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!campaignRows[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "campaign",
    });
  }
  const campaign = campaignRows[0];

  // Tracked-clicks dataset only exists for tracked campaigns.
  if (campaign.link_mode !== "tracked") {
    return apiError(
      409,
      "This campaign does not use tracked links, so it has no tracked-click data. Use the manual clicker export instead.",
      API_ERROR_CODES.VALIDATION,
      { reason: "not_tracked" },
    );
  }

  // Optional stage scoping — verify the stage belongs to this campaign + org.
  let stageNumber: number | null = null;
  if (stageId !== undefined) {
    const stageRows = await db
      .select({ stage_number: campaign_stages.stage_number })
      .from(campaign_stages)
      .where(
        and(
          eq(campaign_stages.id, stageId),
          eq(campaign_stages.campaign_id, cid),
          eq(campaign_stages.org_id, orgId),
        ),
      )
      .limit(1);
    if (!stageRows[0]) {
      return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "stage",
      });
    }
    stageNumber = stageRows[0].stage_number;
  }

  type Row = {
    phone_number: string;
    clicks: number;
    last_clicked_at: string;
  };

  const rowSource = chunkedQuery<Row>({
    fetchChunk: async (offset, chunkLimit) => {
      const result = (await db.execute(drizzleSql`
        select
          c.phone_number,
          count(ck.id)::int as clicks,
          max(ck.clicked_at) as last_clicked_at
        from clicks ck
        inner join links l on l.id = ck.link_id
        inner join contacts c on c.id = l.contact_id
        where ck.org_id = ${orgId}::uuid
          and l.org_id = ${orgId}::uuid
          and l.campaign_id = ${cid}::int
          ${
            stageId !== undefined
              ? drizzleSql`and l.stage_id = ${stageId}::int`
              : drizzleSql``
          }
          ${
            include === "clean"
              ? drizzleSql`and ck.scored_at is not null and ck.classification = 'human'`
              : drizzleSql``
          }
        group by c.id, c.phone_number
        order by c.phone_number asc
        limit ${chunkLimit}
        offset ${offset}
      `)) as unknown as Row[];
      return Array.isArray(result) ? result : [];
    },
  });

  const base = campaign.tracking_id ?? `campaign-${cid}`;
  const stagePart = stageNumber !== null ? `_s${stageNumber}` : "";
  const filename = `${base}${stagePart}_clickers_${include}.csv`;

  return streamCsvResponse({
    filename,
    columns: [
      { key: "phone_number", label: "Phone Number" },
      { key: "clicks", label: "Clicks" },
      { key: "last_clicked_at", label: "Last Clicked At" },
    ],
    rowSource,
    rowMapper: (row) => ({
      phone_number: formatPhoneForExport(row.phone_number),
      clicks: row.clicks,
      last_clicked_at: row.last_clicked_at,
    }),
  });
}
