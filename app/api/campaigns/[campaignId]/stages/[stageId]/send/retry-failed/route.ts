import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import {
  checkAggregateCap,
  pendingScheduledRecipients,
} from "@/lib/guardrails/caps";
import { notifyGuardrailOncePerDay } from "@/lib/guardrails/notify";
import { pendingForStage } from "@/lib/guardrails/pending";

import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { runStageDrain, type DrainRefusal } from "@/lib/sends/drain";

// Requeue a stage's FAILED sends (failed -> pending, clearing last_error) and
// re-drain them. Human-triggered only (no cron, no auto-retry) — matches the
// "attempted, never auto-retry" model: a failed row stays put until someone
// explicitly retries it. Does NOT touch the stage's sent_at lock.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const REFUSAL: Record<DrainRefusal, { status: number; message: string }> = {
  not_found: { status: 404, message: "Stage not found" },
  not_approved: { status: 409, message: "Stage isn't approved to send" },
  send_disabled: { status: 403, message: "Sending is disabled (SEND_ENABLED is off)" },
  send_disabled_org: {
    status: 403,
    message: "Live SMS sending is off — turn it on in Settings → Sending",
  },
  send_paused_org: {
    status: 409,
    message: "Sending is paused (hard-stop engaged) — click Proceed on Today's sends to resume",
  },
  // NOT "paused": no breaker tripped and there is nothing to resume — an
  // operator switched this account off. Different cause, different fix, so a
  // different message.
  provider_sends_disabled: {
    status: 409,
    message:
      "Sending is switched off for this provider — turn it back on in Settings → Providers",
  },
  provider_paused: {
    status: 409,
    message: "Sending is paused for this provider (circuit breaker engaged)",
  },
  campaign_paused: {
    status: 409,
    message: "Sending is paused for this campaign (opt-out-rate breaker or manual pause)",
  },
  no_provider: { status: 400, message: "Stage has no SMS provider" },
  unknown_provider: {
    status: 400,
    message: "Stage's SMS provider has no registered adapter",
  },
  no_credentials: {
    status: 400,
    message: "No API credentials for the stage's provider/brand",
  },
};

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership({
    route: "campaigns/[campaignId]/stages/[stageId]/send/retry-failed",
    method: "POST",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  // manager+ — the money-spending action, same gate as the drain.
  // 869et3vm1 Phase 3: the operator may retry, behind the aggregate cap (applied
  // below). Phase 2 denied this outright for want of a volume limit.
  if (!can(role, "campaigns.drain") && role !== "operator") {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { stageId: sParam } = await params;
  const stageId = parseId(sParam);
  if (stageId === null) {
    return apiError(400, "Invalid stage id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  const requeued = (await db.execute(sql`
    UPDATE stage_sends SET status = 'pending', last_error = NULL
    WHERE stage_id = ${stageId} AND org_id = ${orgId} AND status = 'failed'
    RETURNING id
  `)) as unknown as { id: string }[];

  if (requeued.length === 0) {
    return NextResponse.json({ ok: true, requeued: 0, ...EMPTY_DRAIN });
  }


  // ── Aggregate volume cap — WARN ONLY (Dmytro, 2026-09-04) ───────────────
  //
  // This used to return 409. It was disabled as a block after it refused a
  // legitimate 62,487-recipient day that was never anywhere near 60,000 in any
  // single hour: `pendingScheduledRecipients` sums EVERY approved-unsent
  // recipient with no `scheduled_at` window, so five hours spread across nine
  // days were added together and compared against a per-hour limit. The busiest
  // real hour was 28,249. The refusal also told the operator to "move this to a
  // later hour", which cannot help — a later hour adds to the same total.
  //
  // Re-enabling the block needs that windowing fixed first; Dmytro is planning
  // the semantics separately. Until then the threshold still computes and still
  // reports, so the signal is not lost — it just does not refuse.
  //
  // Deduped once per ET day: without a window the breach is CONTINUOUS while a
  // backlog sits above the line, so an undeduped warn would fire on every single
  // approve-send and train everyone to ignore it.
  {
    const requested = await pendingForStage(orgId, stageId);
    const pending = await pendingScheduledRecipients(orgId);
    const breach = await checkAggregateCap({ orgId, requested, pending });
    if (breach) {
      await notifyGuardrailOncePerDay(
        {
          orgId,
          actorUserId: auth.user.id,
          event: "guardrail.cap_exceeded",
          headline: breach.message,
          detail: [
            `Retry on stage ${stageId}`,
            "Warn-only — the retry was NOT blocked.",
          ],
          entityType: "campaign_stage",
          entityId: String(stageId),
          metadata: { ...breach, enforced: false },
        },
        `aggregate-cap:${orgId}`,
      );
    }
  }

  const result = await runStageDrain(db, { stageId });
  if (!result.ok && result.reason) {
    const r = REFUSAL[result.reason];
    return NextResponse.json(
      { error: r.message, reason: result.reason },
      { status: r.status },
    );
  }
  return NextResponse.json({ ...result, requeued: requeued.length });
}

const EMPTY_DRAIN = {
  sent: 0,
  failed: 0,
  filtered: 0,
  processed: 0,
  halted: false,
  stuck: 0,
  remaining: 0,
};
