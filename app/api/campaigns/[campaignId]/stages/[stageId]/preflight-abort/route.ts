import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { logCampaignEvent } from "@/lib/campaign-events";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const bodySchema = z.object({
  // true → abort this fire (Phase A excludes it); false → clear the abort (re-arm).
  aborted: z.boolean(),
});

// P5 — operator abort during the preflight window. The preflight cron posts a
// Telegram digest ~15 min before a stage materializes; this is the action behind
// that window. Setting `preflight_aborted_at` makes Phase A's due-selection skip
// the stage (mirrors `slip_hold_at` / `schedule_missed_at`); clearing it re-arms.
// Only valid before the stage has materialized/fired (materialized_at & sent_at
// NULL) — once it's sending, use the provider pause or the send/abort recall.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "campaigns.activate")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId: cIdParam, stageId: sIdParam } = await params;
  const campaignId = parseId(cIdParam);
  const stageId = parseId(sIdParam);
  if (campaignId === null || stageId === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }
  const aborting = parsed.data.aborted;

  const result = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT s.materialized_at AS materialized_at, s.sent_at AS sent_at, s.stage_number AS stage_number
      FROM campaign_stages s JOIN campaigns c ON c.id = s.campaign_id
      WHERE s.id = ${stageId} AND s.campaign_id = ${campaignId} AND c.org_id = ${orgId}
      LIMIT 1
    `)) as unknown as { materialized_at: string | null; sent_at: string | null; stage_number: number }[];
    const row = rows[0];
    if (!row) return { notFound: true as const };
    // Aborting only makes sense pre-fire. (Clearing is always allowed.)
    if (aborting && (row.materialized_at != null || row.sent_at != null)) {
      return { tooLate: true as const };
    }

    await tx.execute(sql`
      UPDATE campaign_stages
      SET preflight_aborted_at = ${aborting ? sql`now()` : sql`NULL`}
      WHERE id = ${stageId} AND org_id = ${orgId}
    `);

    await logCampaignEvent(tx, {
      orgId,
      campaignId,
      stageId,
      actorUserId: user.id,
      eventType: aborting ? "preflight_aborted" : "preflight_rearmed",
      summary: aborting
        ? `Stage ${row.stage_number} fire aborted during preflight window`
        : `Stage ${row.stage_number} preflight abort cleared (re-armed)`,
      metadata: {},
    });
    return { ok: true as const };
  });

  if ("notFound" in result) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, { entity: "stage" });
  }
  if ("tooLate" in result) {
    return apiError(409, "This stage has already materialized — too late to abort.", API_ERROR_CODES.VALIDATION, {
      reason: "already_materialized",
    });
  }
  return NextResponse.json({ ok: true, aborted: aborting });
}
