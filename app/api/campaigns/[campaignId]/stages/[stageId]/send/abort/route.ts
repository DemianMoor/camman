import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

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

// Cancel a materialized stage before send (recall / revert-to-editable). A
// materialized, approved stage has live `pending` stage_sends that haven't fired
// — this discards them so the operator can edit and re-materialize. Serves both
// the armed/future-scheduled "Cancel prepared send" and the materialized
// send-now "Cancel" UI affordances. Allowed ONLY while nothing has gone out yet:
// the stage must be UN-RELEASED (`sent_at` NULL) with no `sent`/`sending` rows. A
// stage that already started sending can't be recalled here — pause the provider
// instead.
//
// Effects: pending rows → 'rejected' (terminal, so the partial unique index frees
// up and recipient re-enumeration re-includes them — see lib/sends/recipients.ts),
// send_approved → false, schedule_missed_at cleared, AND materialized_at → NULL so
// a subsequent Prepare re-materializes cleanly instead of short-circuiting as a
// no-op (see lib/sends/kickoff.ts "already fully materialized" gate). scheduled_at
// is kept so the operator can adjust it. Because rejected rows are excluded from
// the panel's `total` count, hasBatch flips false and the stage returns to the
// editable/Prepare state.
export async function POST(
  _req: NextRequest,
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

  const result = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT s.sent_at AS sent_at, s.stage_number AS stage_number,
             count(ss.*) FILTER (WHERE ss.status = 'pending')::int AS pending,
             count(ss.*) FILTER (WHERE ss.status = 'sending')::int AS sending,
             count(ss.*) FILTER (WHERE ss.status = 'sent')::int AS sent
      FROM campaign_stages s
      JOIN campaigns c ON c.id = s.campaign_id
      LEFT JOIN stage_sends ss ON ss.stage_id = s.id
      WHERE s.id = ${stageId} AND s.campaign_id = ${campaignId} AND c.org_id = ${orgId}
      GROUP BY s.sent_at, s.stage_number
    `)) as unknown as {
      sent_at: string | null;
      stage_number: number;
      pending: number;
      sending: number;
      sent: number;
    }[];

    const row = rows[0];
    if (!row) return { notFound: true as const };

    // Refuse if anything already went out / is in flight, or the stage is released.
    if (row.sent_at != null || Number(row.sending) > 0 || Number(row.sent) > 0) {
      return { blocked: true as const };
    }

    const rejected = (await tx.execute(sql`
      UPDATE stage_sends SET status = 'rejected'
      WHERE stage_id = ${stageId} AND org_id = ${orgId} AND status = 'pending'
      RETURNING id
    `)) as unknown as { id: string }[];

    await tx.execute(sql`
      UPDATE campaign_stages
      SET send_approved = false, schedule_missed_at = NULL, materialized_at = NULL
      WHERE id = ${stageId} AND org_id = ${orgId}
    `);

    await logCampaignEvent(tx, {
      orgId,
      campaignId,
      stageId,
      actorUserId: user.id,
      eventType: "send_aborted",
      summary: `Stage ${row.stage_number} armed send recalled: ${rejected.length.toLocaleString()} pending message${rejected.length === 1 ? "" : "s"} discarded`,
      metadata: { discarded: rejected.length },
    });

    return { discarded: rejected.length };
  });

  if ("notFound" in result) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, { entity: "stage" });
  }
  if ("blocked" in result) {
    return apiError(
      409,
      "This send has already started — it can't be recalled. Pause the provider to stop further sending.",
      API_ERROR_CODES.VALIDATION,
      { reason: "already_released" },
    );
  }

  return NextResponse.json({ ok: true, discarded: result.discarded });
}
