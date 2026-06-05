import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { decideScheduledSend, type ProviderSendWindow } from "@/lib/quiet-hours";
import { runStageDrain, type Sender } from "@/lib/sends/drain";
import { kickoffStageSend } from "@/lib/sends/kickoff";

// The send-scheduled cron: fires DUE scheduled sends for API (tracked)
// campaigns. For each due stage it consults the provider's ET send window
// (lib/quiet-hours.ts) and either holds (window not open yet), marks it missed
// (its ET-day window has closed — NEVER rolls to a future day), or fires it.
//
// Firing is at-most-once at the STAGE level via an atomic claim
// (UPDATE … SET sent_at WHERE sent_at IS NULL RETURNING): only one cron tick —
// or a concurrent manual "Send now" — can flip sent_at, so a drain that runs
// past the next tick can't be double-processed. The row-level drain adds a
// second at-most-once guard (FOR UPDATE SKIP LOCKED per recipient).

export interface DueRow {
  stage_id: number;
  campaign_id: number;
  org_id: string;
  scheduled_at: string;
  send_window_weekday_start: number | null;
  send_window_weekday_end: number | null;
  send_window_weekend_start: number | null;
  send_window_weekend_end: number | null;
}

// Read-only selection of DUE scheduled stages: tracked + active campaign,
// approved, scheduled in the past, not yet fired (sent_at NULL) and not already
// missed. Exported so it can be exercised in isolation without side effects.
export async function selectDueScheduledStages(
  dbc: typeof db,
  opts: { now: Date; orgId?: string; maxStages: number },
): Promise<DueRow[]> {
  const { now, orgId, maxStages } = opts;
  // postgres-js raw execute can't bind a JS Date — send an ISO string; Postgres
  // casts it against the timestamptz column.
  const nowIso = now.toISOString();
  return (await dbc.execute(sql`
    SELECT s.id              AS stage_id,
           s.campaign_id     AS campaign_id,
           c.org_id          AS org_id,
           s.scheduled_at    AS scheduled_at,
           p.send_window_weekday_start AS send_window_weekday_start,
           p.send_window_weekday_end   AS send_window_weekday_end,
           p.send_window_weekend_start AS send_window_weekend_start,
           p.send_window_weekend_end   AS send_window_weekend_end
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE c.link_mode = 'tracked'
      AND c.status = 'active'
      AND s.send_approved = true
      AND s.scheduled_at IS NOT NULL
      AND s.scheduled_at <= ${nowIso}
      AND s.sent_at IS NULL
      AND s.schedule_missed_at IS NULL
      AND s.archived_at IS NULL
      ${orgId ? sql`AND c.org_id = ${orgId}` : sql``}
    ORDER BY s.scheduled_at ASC
    LIMIT ${maxStages}
  `)) as unknown as DueRow[];
}

export interface ScheduledRunResult {
  considered: number; // due stages selected this run
  fired: number; // stages whose drain ran
  held: number; // window not open yet (retry next tick)
  missed: number; // window closed -> marked missed
  skipped_claimed: number; // lost the claim race (another tick/manual won)
  refused: number; // pre-send refusal -> claim rolled back
  send_disabled: boolean; // global kill-switch off -> whole run no-op'd
  sent: number; // total messages sent across stages
  failed: number; // total messages failed across stages
}

const BASE: ScheduledRunResult = {
  considered: 0,
  fired: 0,
  held: 0,
  missed: 0,
  skipped_claimed: 0,
  refused: 0,
  send_disabled: false,
  sent: 0,
  failed: 0,
};

function envSendEnabled(): boolean {
  return process.env.SEND_ENABLED === "true";
}

export async function runScheduledSends(
  dbc: typeof db,
  opts?: {
    now?: Date;
    orgId?: string; // manual trigger: scope to one org. Omit for the cron (all orgs).
    isEnabled?: () => boolean;
    sendSms?: Sender;
    maxStages?: number;
  },
): Promise<ScheduledRunResult> {
  const now = opts?.now ?? new Date();
  const isEnabled = opts?.isEnabled ?? envSendEnabled;
  const sendSms = opts?.sendSms;
  const maxStages = opts?.maxStages ?? 50;
  const orgId = opts?.orgId;

  // Master kill-switch: with global sending off, no-op entirely — don't claim,
  // don't mark missed. Everything waits for the next tick once enabled (subject
  // to the same window/missed rules then).
  if (!isEnabled()) return { ...BASE, send_disabled: true };

  const due = await selectDueScheduledStages(dbc, { now, orgId, maxStages });
  const nowIso = now.toISOString(); // raw execute can't bind a JS Date

  const result: ScheduledRunResult = { ...BASE, considered: due.length };

  for (const row of due) {
    const cfg: ProviderSendWindow = {
      send_window_weekday_start: row.send_window_weekday_start,
      send_window_weekday_end: row.send_window_weekday_end,
      send_window_weekend_start: row.send_window_weekend_start,
      send_window_weekend_end: row.send_window_weekend_end,
    };
    const decision = decideScheduledSend(cfg, new Date(row.scheduled_at), now);

    if (decision === "hold") {
      result.held++;
      continue;
    }

    if (decision === "missed") {
      // Guarded so a concurrent claim/manual send isn't clobbered.
      await dbc.execute(sql`
        UPDATE campaign_stages SET schedule_missed_at = ${nowIso}
        WHERE id = ${row.stage_id}
          AND sent_at IS NULL
          AND schedule_missed_at IS NULL
      `);
      result.missed++;
      continue;
    }

    // decision === "fire" — atomic stage claim.
    const claimed = (await dbc.execute(sql`
      UPDATE campaign_stages SET sent_at = ${nowIso}
      WHERE id = ${row.stage_id} AND sent_at IS NULL
      RETURNING id
    `)) as unknown as { id: number }[];
    if (claimed.length === 0) {
      result.skipped_claimed++;
      continue;
    }

    // Materialize (mint) then drain. Roll the claim back ONLY on a pre-send
    // refusal (nothing materialized). 'already_pending' means rows from a prior
    // partial run exist — proceed to drain them, keep the claim.
    const kickoff = await dbc.transaction((tx) =>
      kickoffStageSend(tx, {
        orgId: row.org_id,
        campaignId: row.campaign_id,
        stageId: row.stage_id,
      }),
    );
    if (!kickoff.ok && kickoff.reason !== "already_pending") {
      await dbc.execute(sql`
        UPDATE campaign_stages SET sent_at = NULL WHERE id = ${row.stage_id}
      `);
      result.refused++;
      continue;
    }

    const drain = await runStageDrain(dbc, {
      stageId: row.stage_id,
      sendSms,
      isEnabled,
    });
    result.fired++;
    result.sent += drain.sent;
    result.failed += drain.failed;
  }

  return result;
}
