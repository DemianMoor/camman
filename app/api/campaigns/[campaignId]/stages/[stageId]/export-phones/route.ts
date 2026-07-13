import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { campaign_stages, campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import {
  chunkedQuery,
  streamCsvResponse,
} from "@/lib/csv/stream-export";
import { can } from "@/lib/permissions";
import { formatPhoneForExport } from "@/lib/phone-validation";
import { stageRecipientsSql } from "@/lib/sends/recipients";

// Streams a chunked, content-deduped recipient query. Without an explicit
// budget this ran on the platform default (~15s) and silently truncated the
// CSV mid-stream on large stages (recon §6). Match the sibling exports
// (export-clickers / export-contacts), which are already 60. Deeper fix of the
// OFFSET pagination in the chunker is deferred to W3.
export const maxDuration = 60;

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const querySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  // Future-proof: 'e164' could emit leading-+ numbers; default 10-digit is
  // what bulk-upload providers (SendNexus, TextHub) want today.
  format: z.enum(["10digit", "e164"]).default("10digit"),
});

// Resolved-audience CSV export for one stage. Streams one column of phone
// numbers (10-digit national for US; libphonenumber's national format for
// non-US — matches the audience-layer convention). The filter logic mirrors
// the audience-count endpoint exactly: pool ∩ stage filter toggles, minus
// live opt-outs.
export async function GET(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  // Exporting is view-equivalent — anyone who can see the stage can export.
  if (!can(role, "stages.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId, stageId } = await params;
  const cid = parseId(campaignId);
  const sid = parseId(stageId);
  if (cid === null || sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const parsedQuery = querySchema.safeParse({
    limit: req.nextUrl.searchParams.get("limit") ?? undefined,
    format: req.nextUrl.searchParams.get("format") ?? undefined,
  });
  if (!parsedQuery.success) {
    return apiError(
      400,
      parsedQuery.error.issues[0]?.message ?? "Invalid query",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const { limit: queryLimit, format } = parsedQuery.data;

  // Verify ownership + grab the bits we need for the filename and filter.
  const rows = await db
    .select({
      stage_number: campaign_stages.stage_number,
      include_no_status: campaign_stages.include_no_status,
      include_clickers: campaign_stages.include_clickers,
      exclude_clickers: campaign_stages.exclude_clickers,
      split_index: campaign_stages.split_index,
      split_total: campaign_stages.split_total,
      tracking_id: campaign_stages.tracking_id,
      creative_id: campaign_stages.creative_id,
      offer_id: campaigns.offer_id,
      exclude_prior_offer_contacts: campaigns.exclude_prior_offer_contacts,
    })
    .from(campaign_stages)
    .innerJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
    .where(
      and(
        eq(campaign_stages.id, sid),
        eq(campaign_stages.campaign_id, cid),
        eq(campaign_stages.org_id, orgId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "stage",
    });
  }
  const stage = rows[0];

  if (!stage.tracking_id) {
    return apiError(
      409,
      "Stage is missing a tracking ID. Set the campaign brand and offer, and the stage creative, before exporting.",
      API_ERROR_CODES.VALIDATION,
      { reason: "missing_tracking_id" },
    );
  }

  // Build the filter snippets once. Same logic as the audience-count helper,
  // but here we need to select phone_number per row and apply offset/limit
  // for chunked streaming, so we run it as a tagged-template query rather
  // than reusing the count helper.
  const includeNs = stage.include_no_status;
  const includeCl = stage.include_clickers;
  const excludeCl = stage.exclude_clickers;
  const splitIndex = stage.split_index ?? null;
  const splitTotal = stage.split_total ?? null;

  const rowSource = chunkedQuery({
    fetchChunk: async (offset, chunkLimit) => {
      const remaining =
        queryLimit !== undefined
          ? Math.max(0, queryLimit - offset)
          : chunkLimit;
      if (remaining === 0) return [] as { phone_number: string }[];
      const effectiveLimit = Math.min(chunkLimit, remaining);

      // Shared recipient query (lib/sends/recipients.ts) — the same SELECT the
      // send pipeline uses, so export and send can never diverge. Split
      // partitioning + stable contact_id ordering live in that builder.
      const result = (await db.execute(
        stageRecipientsSql({
          campaignId: cid,
          orgId,
          filters: {
            includeNoStatus: includeNs,
            includeClickers: includeCl,
            excludeClickers: excludeCl,
            splitIndex,
            splitTotal,
          },
          // Same content-dedup the send pipeline applies — an exported CSV is a
          // manual send, so it must not re-send a creative/offer a lead already
          // got. (Export still writes nothing to the ledger; externally-sent
          // exposures remain the known manual-CSV blind spot.)
          eligibility: {
            creativeId: stage.creative_id ?? null,
            offerId: stage.offer_id ?? null,
            excludePriorOffer: stage.exclude_prior_offer_contacts,
          },
          limit: effectiveLimit,
          offset,
        }),
      )) as unknown as { phone_number: string }[];
      return Array.isArray(result) ? result : [];
    },
  });

  return streamCsvResponse({
    filename: `${stage.tracking_id}.csv`,
    columns: [{ key: "phone_number", label: "Phone Number" }],
    rowSource,
    rowMapper: (row) => ({
      phone_number:
        format === "e164"
          ? row.phone_number
          : formatPhoneForExport(row.phone_number),
    }),
  });
}
