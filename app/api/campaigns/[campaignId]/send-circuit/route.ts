import { and, eq, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { campaign_circuit_events, campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { logCampaignEvent } from "@/lib/campaign-events";
import { can } from "@/lib/permissions";
import {
  decideScheduledSend,
  nextWindowOpenAtOrAfter,
  type ProviderSendWindow,
} from "@/lib/quiet-hours";
import { decideScheduleEdit } from "@/lib/sends/schedule-edit";
import { isScheduledAtInPast } from "@/lib/sends/schedule-guard";

// P7/P8 — manual control of a campaign's latching send pause. Mirrors the
// provider send-circuit route, on the campaign row + campaign_circuit_events:
//   action: "pause"  → manually latch (independent of the provider latch).
//   action: "resume" → clear a pause (auto-tripped by the opt-out-rate breaker,
//                      or manual). The ONLY way to clear the latch.
// Every transition appends an audit row stamped with the acting user. Orthogonal
// to campaigns.status — this never changes the lifecycle state.
//
// GET returns the campaign's pause state plus its still-unfired stages, each
// classified by decideScheduledSend, so the resume dialog can tell the operator
// which stages fire on their own and which need a new time.
//
// POST optionally carries `redate_stages` so RESUME and RE-DATE commit in ONE
// transaction. Recovering from a pause usually needs both (§6.3 of the incident
// brief: the send window is anchored to scheduled_at's ET day, so a campaign
// resumed after that day's close would have its stages stamped missed on the very
// next tick). Doing it as resume-then-N-PATCHes can half-apply and leaves a
// scattered audit trail.
const redateSchema = z.object({
  stage_id: z.number().int().positive(),
  scheduled_at: z.string().datetime({ offset: true }),
});

const bodySchema = z.object({
  action: z.enum(["pause", "resume"]),
  reason: z.string().trim().max(200).optional(),
  redate_stages: z.array(redateSchema).max(100).optional(),
});

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Thrown (not returned) from inside the transaction so a bad re-date ROLLS BACK
// the resume too — returning early would commit a half-applied recovery, which
// is the exact failure mode this endpoint exists to prevent.
class TxAbort extends Error {
  constructor(readonly kind: "stage_not_found" | "stage_locked", readonly stageId: number) {
    super(kind);
  }
}

interface StageRow {
  stage_id: number;
  stage_number: number | null;
  label: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  schedule_missed_at: string | null;
  link_mode: string | null;
  pending: number;
  send_window_weekday_start: number | null;
  send_window_weekday_end: number | null;
  send_window_weekend_start: number | null;
  send_window_weekend_end: number | null;
}

function windowCfg(r: StageRow): ProviderSendWindow {
  return {
    send_window_weekday_start: r.send_window_weekday_start,
    send_window_weekday_end: r.send_window_weekday_end,
    send_window_weekend_start: r.send_window_weekend_start,
    send_window_weekend_end: r.send_window_weekend_end,
  };
}

// Stages of the campaign that have NOT fired yet — the ones a pause actually
// holds. A released stage (sent_at set) resumes draining on its own, and an
// archived one is off the pipeline.
async function selectUnfiredStages(orgId: string, campaignId: number): Promise<StageRow[]> {
  return (await db.execute(sql`
    SELECT s.id              AS stage_id,
           s.stage_number    AS stage_number,
           s.label           AS label,
           s.scheduled_at    AS scheduled_at,
           s.sent_at         AS sent_at,
           s.schedule_missed_at AS schedule_missed_at,
           c.link_mode       AS link_mode,
           (SELECT count(*)::int FROM stage_sends ss
              WHERE ss.stage_id = s.id AND ss.status = 'pending') AS pending,
           p.send_window_weekday_start AS send_window_weekday_start,
           p.send_window_weekday_end   AS send_window_weekday_end,
           p.send_window_weekend_start AS send_window_weekend_start,
           p.send_window_weekend_end   AS send_window_weekend_end
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE s.campaign_id = ${campaignId} AND c.org_id = ${orgId}
      AND s.archived_at IS NULL
      AND s.status <> 'archived'
      AND s.sent_at IS NULL
    ORDER BY s.scheduled_at ASC NULLS LAST, s.id ASC
  `)) as unknown as StageRow[];
}

/**
 * What happens to a stage the moment the campaign resumes.
 *   unscheduled — no scheduled_at; the cron never picks it up.
 *   future      — its time hasn't come yet; nothing to do.
 *   fire        — due and inside its send window; goes on the next tick.
 *   hold        — due but the window hasn't opened yet today; fires when it does.
 *   missed      — its ET day's window has closed (or it is already stamped
 *                 missed). Resuming alone will NOT send it — it needs a new time.
 */
export type ResumeStageDecision = "unscheduled" | "future" | "fire" | "hold" | "missed";

function classifyStage(r: StageRow, now: Date): {
  decision: ResumeStageDecision;
  suggested_scheduled_at: string | null;
} {
  const cfg = windowCfg(r);
  const suggested = nextWindowOpenAtOrAfter(cfg, now).toISOString();
  if (r.scheduled_at == null) return { decision: "unscheduled", suggested_scheduled_at: suggested };
  if (r.schedule_missed_at != null) return { decision: "missed", suggested_scheduled_at: suggested };
  const scheduledAt = new Date(r.scheduled_at);
  if (scheduledAt > now) return { decision: "future", suggested_scheduled_at: null };
  const d = decideScheduledSend(cfg, scheduledAt, now);
  return {
    decision: d,
    suggested_scheduled_at: d === "missed" ? suggested : null,
  };
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

  const { campaignId: cParam } = await params;
  const campaignId = parseId(cParam);
  if (campaignId === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  const existing = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      send_paused: campaigns.send_paused,
      send_paused_reason: campaigns.send_paused_reason,
      send_paused_at: campaigns.send_paused_at,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!existing[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, { entity: "campaign" });
  }

  const now = new Date();
  const stages = (await selectUnfiredStages(orgId, campaignId)).map((r) => {
    const { decision, suggested_scheduled_at } = classifyStage(r, now);
    return {
      stage_id: Number(r.stage_id),
      stage_number: r.stage_number,
      label: r.label,
      scheduled_at: r.scheduled_at,
      schedule_missed_at: r.schedule_missed_at,
      pending: Number(r.pending ?? 0),
      decision,
      suggested_scheduled_at,
    };
  });

  return NextResponse.json({ campaign: existing[0], stages });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "campaigns.pause")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId: cParam } = await params;
  const campaignId = parseId(cParam);
  if (campaignId === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION, { field: "id" });
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
  const { action } = parsed.data;
  const reason = parsed.data.reason ?? (action === "pause" ? "manual" : null);
  const redates = parsed.data.redate_stages ?? [];

  // Re-dating only makes sense on the way OUT of a pause; pairing it with a pause
  // would be an unrelated schedule edit smuggled into a circuit action.
  if (redates.length > 0 && action !== "resume") {
    return apiError(400, "redate_stages is only valid with action \"resume\".",
      API_ERROR_CODES.VALIDATION, { field: "redate_stages" });
  }
  if (new Set(redates.map((r) => r.stage_id)).size !== redates.length) {
    return apiError(400, "Duplicate stage_id in redate_stages.",
      API_ERROR_CODES.VALIDATION, { field: "redate_stages" });
  }
  for (const r of redates) {
    if (isScheduledAtInPast(r.scheduled_at)) {
      return apiError(400, `Stage ${r.stage_id}: the new scheduled time is in the past.`,
        API_ERROR_CODES.VALIDATION, { field: "scheduled_at", stage_id: r.stage_id });
    }
  }

  let result: { notFound: true } | { changed: boolean; send_paused: boolean; redated: number };
  try {
    result = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: campaigns.id, send_paused: campaigns.send_paused })
        .from(campaigns)
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)))
        .limit(1);
      if (!existing[0]) return { notFound: true as const };

      const want = action === "pause";
      const changed = existing[0].send_paused !== want;

      if (changed) {
        await tx
          .update(campaigns)
          .set({
            send_paused: want,
            send_paused_reason: want ? reason : null,
            send_paused_at: want ? new Date() : null,
          })
          .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)));

        await tx.insert(campaign_circuit_events).values({
          org_id: orgId,
          campaign_id: campaignId,
          event: want ? "paused" : "resumed",
          reason,
          actor_user_id: user.id,
        });
      }

      // Re-date inside the SAME transaction, so a resume never lands without the
      // schedule fixes it was paired with (and vice versa).
      let redated = 0;
      for (const r of redates) {
        const rows = (await tx.execute(sql`
          SELECT s.id AS stage_id, s.stage_number AS stage_number, s.scheduled_at AS scheduled_at,
                 s.sent_at AS sent_at, s.schedule_missed_at AS schedule_missed_at,
                 c.link_mode AS link_mode
          FROM campaign_stages s JOIN campaigns c ON c.id = s.campaign_id
          WHERE s.id = ${r.stage_id} AND s.campaign_id = ${campaignId} AND c.org_id = ${orgId}
          LIMIT 1
        `)) as unknown as {
          stage_id: number;
          stage_number: number | null;
          scheduled_at: string | null;
          sent_at: string | null;
          schedule_missed_at: string | null;
          link_mode: string | null;
        }[];
        const stage = rows[0];
        if (!stage) throw new TxAbort("stage_not_found", r.stage_id);

        // Held stages have sent_at NULL so the reschedule lock is structurally
        // false here — but route through the shared decision anyway so
        // `clearMissed` comes from the one place that owns that rule.
        const decision = decideScheduleEdit(
          {
            linkMode: stage.link_mode,
            sentAt: stage.sent_at,
            scheduleMissedAt: stage.schedule_missed_at,
            currentScheduledAt: stage.scheduled_at,
          },
          r.scheduled_at,
        );
        if (decision.locked) throw new TxAbort("stage_locked", r.stage_id);
        if (!decision.scheduledChanged) continue;

        await tx.execute(sql`
          UPDATE campaign_stages
          SET scheduled_at = ${r.scheduled_at}::timestamptz
              ${decision.clearMissed ? sql`, schedule_missed_at = NULL` : sql``}
          WHERE id = ${r.stage_id} AND org_id = ${orgId}
        `);
        redated++;

        await logCampaignEvent(tx, {
          orgId,
          campaignId,
          stageId: r.stage_id,
          actorUserId: user.id,
          eventType: "stage_scheduled",
          summary: `Stage ${stage.stage_number ?? r.stage_id} re-dated while resuming the campaign send circuit`,
          metadata: {
            from: stage.scheduled_at,
            to: r.scheduled_at,
            cleared_missed: decision.clearMissed,
            via: "send_circuit_resume",
          },
        });
      }

      return { changed, send_paused: want, redated };
    });
  } catch (err) {
    if (err instanceof TxAbort) {
      return err.kind === "stage_not_found"
        ? apiError(404, `Stage ${err.stageId} not found on this campaign`,
            API_ERROR_CODES.NOT_FOUND, { entity: "stage" })
        : apiError(409, `Stage ${err.stageId} has already sent — its schedule is locked.`,
            API_ERROR_CODES.VALIDATION, { reason: "scheduled_locked_after_send" });
    }
    throw err;
  }

  if ("notFound" in result) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, { entity: "campaign" });
  }
  return NextResponse.json({ ok: true, ...result });
}
