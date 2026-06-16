import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
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
  provider_paused: {
    status: 409,
    message: "Sending is paused for this provider (circuit breaker engaged)",
  },
  no_provider: { status: 400, message: "Stage has no SMS provider" },
  no_credentials: {
    status: 400,
    message: "No API credentials for the stage's provider/brand",
  },
};

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  // manager+ — the money-spending action, same gate as the drain.
  if (!can(role, "campaigns.drain")) {
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
