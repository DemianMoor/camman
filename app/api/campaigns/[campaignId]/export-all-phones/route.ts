import { and, asc, eq, ne, sql as drizzleSql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_stages, campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import {
  buildExportFilename,
  chunkedQuery,
  streamCsvResponse,
} from "@/lib/csv/stream-export";
import { can } from "@/lib/permissions";
import { formatPhoneForExport } from "@/lib/phone-validation";

// Union-of-stages phone export for a campaign. Returns one row per
// (phone, stage) pair from the resolved audience of every non-archived
// stage. Same semantics as the per-stage endpoint (pool ∩ stage filter
// toggles, minus live opt-outs), unioned across stages with stage_number
// and stage_label columns so the caller can see which stage each phone
// came from. Phones that satisfy multiple stages' filters appear once
// per stage.

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function GET(
  _req: NextRequest,
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
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION);
  }

  // Verify ownership + grab the campaign slug for the filename.
  const campaignRows = await db
    .select({ slug: campaigns.slug, status: campaigns.status })
    .from(campaigns)
    .where(and(eq(campaigns.id, cid), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!campaignRows[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "campaign",
    });
  }
  const campaign = campaignRows[0];

  // Gather the non-archived stages we'll union over.
  const stages = await db
    .select({
      id: campaign_stages.id,
      stage_number: campaign_stages.stage_number,
      label: campaign_stages.label,
      include_no_status: campaign_stages.include_no_status,
      include_clickers: campaign_stages.include_clickers,
      exclude_clickers: campaign_stages.exclude_clickers,
    })
    .from(campaign_stages)
    .where(
      and(
        eq(campaign_stages.campaign_id, cid),
        eq(campaign_stages.org_id, orgId),
        ne(campaign_stages.status, "archived"),
      ),
    )
    .orderBy(asc(campaign_stages.stage_number));

  // No non-archived stages? Stream an empty CSV (header only) so the
  // download still produces something — callers can open it to confirm.
  type Row = {
    phone_number: string;
    stage_number: number;
    stage_label: string;
  };

  const rowSource =
    stages.length === 0
      ? chunkedQuery<Row>({
          fetchChunk: async () => [],
        })
      : chunkedQuery<Row>({
          fetchChunk: async (offset, chunkLimit) => {
            // We materialize each stage's resolved set into a UNION ALL
            // subquery, then page through the whole thing with LIMIT/OFFSET.
            // For a campaign with ~10 stages and ~1M pool entries, this
            // pages efficiently because the inner UNION is computed by
            // Postgres once and the outer LIMIT scans linearly.
            const fragments = stages.map((s) => {
              const includeNs = s.include_no_status;
              const includeCl = s.include_clickers;
              const excludeCl = s.exclude_clickers;
              const label = s.label ?? "";
              return drizzleSql`
                select
                  c.phone_number,
                  ${s.stage_number}::int as stage_number,
                  ${label}::text as stage_label
                from campaign_audience_pool p
                inner join contacts c on c.id = p.contact_id
                where p.campaign_id = ${cid}::int
                  and p.org_id = ${orgId}::uuid
                  and not exists (
                    select 1 from opt_outs oo
                    where oo.contact_id = p.contact_id
                      and oo.org_id = ${orgId}::uuid
                  )
                  and (
                    (${includeNs}::boolean and p.was_no_status_at_snapshot)
                    or (${includeCl}::boolean and p.was_clicker_at_snapshot)
                  )
                  and not (${excludeCl}::boolean and p.was_clicker_at_snapshot)
              `;
            });
            const unionAll = fragments.reduce((acc, frag, i) =>
              i === 0 ? frag : drizzleSql`${acc} union all ${frag}`,
            );
            const result = (await db.execute(drizzleSql`
              select phone_number, stage_number, stage_label
              from (${unionAll}) all_stages
              order by stage_number asc, phone_number asc
              limit ${chunkLimit}
              offset ${offset}
            `)) as unknown as Row[];
            return Array.isArray(result) ? result : [];
          },
        });

  return streamCsvResponse({
    filename: buildExportFilename(`campaign-${campaign.slug}-all-phones`),
    columns: [
      { key: "phone_number", label: "Phone Number" },
      { key: "stage_number", label: "Stage Number" },
      { key: "stage_label", label: "Stage Label" },
    ],
    rowSource,
    rowMapper: (row) => ({
      phone_number: formatPhoneForExport(row.phone_number),
      stage_number: row.stage_number,
      stage_label: row.stage_label,
    }),
  });
}
