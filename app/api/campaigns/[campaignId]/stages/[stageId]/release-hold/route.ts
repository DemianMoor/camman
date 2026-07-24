import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { logCampaignEvent } from "@/lib/campaign-events";
import { can } from "@/lib/permissions";
import { isScheduledAtInPast } from "@/lib/sends/schedule-guard";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const bodySchema = z.object({
  // Optional new fire time. When supplied it becomes the child's schedule AND its
  // preserved "original" (an explicit operator re-date overwrites the auto-slip
  // audit trail — Q4). Omit to release the hold at the child's current time.
  scheduled_at: z.string().datetime({ offset: true }).optional(),
});

// P6 — release a slip-held lane child (migration 0117 `slip_hold_at`). A child
// parked at the 24h slip cap does NOT fire and is excluded by the cron's
// `slip_hold_at IS NULL` gate; no other endpoint clears it. This resets the slip
// state so the P4 parent-complete gate re-evaluates cleanly on the next tick:
// clears `slip_hold_at` + `slip_hold_reason`, resets `slip_count = 0`, and
// PRESERVES `slip_original_scheduled_at` for audit — UNLESS the operator supplies
// an explicit new `scheduled_at`, which overwrites both the schedule and the
// original. Requires the stage to actually be held.
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

  let json: unknown = {};
  try {
    const raw = await req.text();
    if (raw) json = JSON.parse(raw);
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }
  const newScheduledAt = parsed.data.scheduled_at ?? null;
  if (newScheduledAt && isScheduledAtInPast(newScheduledAt)) {
    return apiError(400, "The new scheduled time is in the past.", API_ERROR_CODES.VALIDATION, {
      field: "scheduled_at",
    });
  }

  const result = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT s.slip_hold_at AS slip_hold_at, s.stage_number AS stage_number
      FROM campaign_stages s JOIN campaigns c ON c.id = s.campaign_id
      WHERE s.id = ${stageId} AND s.campaign_id = ${campaignId} AND c.org_id = ${orgId}
      LIMIT 1
    `)) as unknown as { slip_hold_at: string | null; stage_number: number }[];
    const row = rows[0];
    if (!row) return { notFound: true as const };
    if (row.slip_hold_at == null) return { notHeld: true as const };

    await tx.execute(sql`
      UPDATE campaign_stages
      SET slip_hold_at = NULL,
          slip_hold_reason = NULL,
          slip_count = 0,
          ${newScheduledAt
            ? sql`scheduled_at = ${newScheduledAt}::timestamptz,
                  slip_original_scheduled_at = ${newScheduledAt}::timestamptz,`
            : sql``}
          schedule_missed_at = NULL
      WHERE id = ${stageId} AND org_id = ${orgId}
    `);

    await logCampaignEvent(tx, {
      orgId,
      campaignId,
      stageId,
      actorUserId: user.id,
      eventType: "slip_hold_released",
      summary: newScheduledAt
        ? `Stage ${row.stage_number} hold released and re-dated`
        : `Stage ${row.stage_number} hold released`,
      metadata: { re_dated: newScheduledAt },
    });
    return { ok: true as const };
  });

  if ("notFound" in result) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, { entity: "stage" });
  }
  if ("notHeld" in result) {
    return apiError(409, "This stage is not held.", API_ERROR_CODES.VALIDATION, { reason: "not_held" });
  }
  return NextResponse.json({ ok: true, re_dated: newScheduledAt });
}
