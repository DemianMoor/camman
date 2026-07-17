import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_stages } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { getOrgSendsEnabled } from "@/lib/sends/org-send-flag";
import { computeStageReconciliation } from "@/lib/sends/reconcile";
import { summarizeStageAttempts } from "@/lib/sends/attempt-summary";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Send-panel status for a stage: the gate states + live stage_sends counts.
// Read-only, session-gated (campaigns.view), org-scoped. `send_enabled` is the
// boolean form of SEND_ENABLED only — never the raw env value.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { stageId: sParam } = await params;
  const stageId = parseId(sParam);
  if (stageId === null) {
    return apiError(400, "Invalid stage id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  const stage = await db
    .select({
      campaign_id: campaign_stages.campaign_id,
      send_approved: campaign_stages.send_approved,
      scheduled_at: campaign_stages.scheduled_at,
      sent_at: campaign_stages.sent_at,
      schedule_missed_at: campaign_stages.schedule_missed_at,
      include_no_status: campaign_stages.include_no_status,
      include_clickers: campaign_stages.include_clickers,
      exclude_clickers: campaign_stages.exclude_clickers,
      split_index: campaign_stages.split_index,
      split_total: campaign_stages.split_total,
    })
    .from(campaign_stages)
    .where(and(eq(campaign_stages.id, stageId), eq(campaign_stages.org_id, orgId)))
    .limit(1);
  if (!stage[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, { entity: "stage" });
  }

  const counts = (await db.execute(drizzleSql`
    SELECT
      -- 'rejected' rows are canceled/recalled sends kept only for audit. They
      -- must NOT count toward the total, else a fully-canceled stage keeps
      -- hasBatch=true and the panel stays stuck on the materialized branch
      -- instead of returning to the editable/Prepare state.
      count(*) FILTER (WHERE status <> 'rejected')::int AS total,
      count(*) FILTER (WHERE status = 'pending')::int  AS pending,
      count(*) FILTER (WHERE status = 'sending')::int  AS sending,
      count(*) FILTER (WHERE status = 'sent')::int     AS sent,
      count(*) FILTER (WHERE status = 'failed')::int   AS failed
    FROM stage_sends WHERE stage_id = ${stageId} AND org_id = ${orgId}
  `)) as unknown as {
    total: number;
    pending: number;
    sending: number;
    sent: number;
    failed: number;
  }[];

  const c = counts[0] ?? { total: 0, pending: 0, sending: 0, sent: 0, failed: 0 };

  // The drain gate is a conjunction (Workstream 1): the env SEND_ENABLED backstop
  // AND the DB master switch. Expose the effective value plus each input so the
  // panel can name the exact blocker.
  const envEnabled = process.env.SEND_ENABLED === "true";
  const orgEnabled = await getOrgSendsEnabled(db, orgId);

  // One materialized row's frozen body — the REAL composed message (with the
  // real minted link) that will send. Representative: all rows share the same
  // composition, differing only in the per-recipient code. Null before kickoff.
  const sample = (await db.execute(drizzleSql`
    SELECT rendered_text FROM stage_sends
    WHERE stage_id = ${stageId} AND org_id = ${orgId}
    ORDER BY created_at ASC, id ASC LIMIT 1
  `)) as unknown as { rendered_text: string }[];

  // Reconciliation (pool = attempted + excluded, gap 0) + attempt-evidence
  // breakdown (mine/theirs/indeterminate). Only meaningful once materialized;
  // before kickoff `attempted` is 0 and the breakdown is empty.
  const reconciliation = await computeStageReconciliation(db, {
    campaignId: stage[0].campaign_id,
    orgId,
    stageId,
    filters: {
      includeNoStatus: stage[0].include_no_status,
      includeClickers: stage[0].include_clickers,
      excludeClickers: stage[0].exclude_clickers,
      splitIndex: stage[0].split_index ?? null,
      splitTotal: stage[0].split_total ?? null,
    },
  });
  const attempts = await summarizeStageAttempts(db, { stageId, orgId });

  return NextResponse.json({
    send_approved: stage[0].send_approved,
    // Effective gate (both switches). Kept as `send_enabled` so existing
    // consumers read the true drain gate, not just the env half.
    send_enabled: envEnabled && orgEnabled,
    env_send_enabled: envEnabled,
    org_sends_enabled: orgEnabled,
    reconciliation,
    attempts,
    scheduled_at: stage[0].scheduled_at,
    sent_at: stage[0].sent_at,
    schedule_missed_at: stage[0].schedule_missed_at,
    counts: {
      total: Number(c.total),
      pending: Number(c.pending),
      sending: Number(c.sending),
      sent: Number(c.sent),
      failed: Number(c.failed),
    },
    sample_rendered_text: sample[0]?.rendered_text ?? null,
  });
}
