import { db } from "@/db/client";
import { campaign_events } from "@/db/schema";

export type DbOrTx =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

// The audited campaign actions. Free-text in the DB (no CHECK) so adding a kind
// never needs a migration, but typed here so callers stay consistent and the UI
// can map each to an icon/label.
export type CampaignEventType =
  | "campaign_created"
  | "campaign_status_changed"
  | "stage_created"
  | "stage_status_changed"
  | "stage_scheduled"
  | "send_approved"
  | "send_kickoff"
  | "send_drain"
  | "results_imported"
  | "results_reverted";

export interface LogCampaignEventInput {
  orgId: string;
  campaignId: number;
  /** The stage this event concerns, when applicable. */
  stageId?: number | null;
  eventType: CampaignEventType;
  /** Auth user id of the actor; omit/null for system/cron actions. */
  actorUserId?: string | null;
  /** Human-readable one-liner shown in the timeline. */
  summary: string;
  /** Structured detail (from/to status, counts, stop reason, …). */
  metadata?: Record<string, unknown> | null;
}

// Append one row to the campaign activity log. Best-effort: an audit-write
// failure must never break the user action that triggered it, so errors are
// swallowed (logged) rather than thrown. Pass the surrounding transaction (`tx`)
// when one exists so the event commits atomically with its action; otherwise
// pass `db` for a standalone write.
//
// NOTE: when called inside a transaction, place this AFTER the primary mutation
// and trust the insert — a thrown error here would abort the whole transaction
// regardless of the catch (Postgres marks the tx aborted on any error).
export async function logCampaignEvent(
  dbc: DbOrTx,
  input: LogCampaignEventInput,
): Promise<void> {
  try {
    await dbc.insert(campaign_events).values({
      org_id: input.orgId,
      campaign_id: input.campaignId,
      stage_id: input.stageId ?? null,
      event_type: input.eventType,
      actor_user_id: input.actorUserId ?? null,
      summary: input.summary,
      metadata: input.metadata ?? null,
    });
  } catch (err) {
    console.error("[campaign-events] failed to log event", input.eventType, err);
  }
}
