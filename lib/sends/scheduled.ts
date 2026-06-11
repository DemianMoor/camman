import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { decideScheduledSend, type ProviderSendWindow } from "@/lib/quiet-hours";
import { isProviderPaused, resolvePacingCap } from "@/lib/sends/circuit-breakers";
import { runStageDrain, type DrainResult, type Sender } from "@/lib/sends/drain";
import { kickoffStageSend, type KickoffRefusal } from "@/lib/sends/kickoff";

// The send-scheduled cron. Two phases per tick, both bounded by the SAME
// per-provider per-tick send budget:
//
//   Phase A — MATERIALIZE: for each DUE, not-yet-materialized scheduled stage,
//     consult the provider's ET window (hold / missed / fire), then kickoff
//     (mint links + stage_sends rows). `sent_at` is stamped only AFTER kickoff
//     succeeds, so a tick killed mid-materialize can't strand the stage with a
//     committed claim and zero rows — the next tick simply retries. Concurrency
//     is guarded structurally by the `stage_sends_active_contact_uniq` dedup
//     index (two ticks materializing the same stage → one wins, the other's
//     INSERT raises 23505 and is caught), so no pre-claim is needed.
//
//   Phase B — DRAIN: any tracked stage that still has `pending` stage_sends is
//     drained in a bounded batch (the provider's remaining per-tick budget).
//     This is what makes large audiences safe: sending is RESUMABLE across
//     ticks instead of trying to push the whole audience inside one 300s
//     invocation. Just-materialized stages are picked up here in the same tick,
//     so first-send still happens promptly.

export interface DueRow {
  stage_id: number;
  campaign_id: number;
  org_id: string;
  provider_id: number | null;
  scheduled_at: string;
  send_window_weekday_start: number | null;
  send_window_weekday_end: number | null;
  send_window_weekend_start: number | null;
  send_window_weekend_end: number | null;
}

// Read-only selection of DUE, NOT-YET-MATERIALIZED scheduled stages: tracked +
// active campaign, approved, scheduled in the past, not yet fired (sent_at
// NULL), not already missed, and with NO stage_sends rows yet (so a stage that
// was materialized but not stamped — a tick killed between the two — isn't
// re-materialized; phase B drains it instead). Exported for isolated tests.
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
           s.sms_provider_id AS provider_id,
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
      -- A paused provider holds ALL its scheduled stages: don't even consider
      -- them, so they materialize once a human resumes.
      AND (p.send_paused IS NOT TRUE)
      -- Not yet materialized (idempotent re-entry after a killed tick).
      AND NOT EXISTS (
        SELECT 1 FROM stage_sends ss WHERE ss.stage_id = s.id
      )
      ${orgId ? sql`AND c.org_id = ${orgId}` : sql``}
    ORDER BY s.scheduled_at ASC
    LIMIT ${maxStages}
  `)) as unknown as DueRow[];
}

export interface DrainableRow {
  stage_id: number;
  org_id: string;
  provider_id: number | null;
  max_sends_per_run: number | null;
}

// Read-only selection of tracked stages that still have `pending` sends to
// drain (approved, active campaign, provider not paused). Independent of
// sent_at — this is the resumable-drain feed, so a stage keeps being drained
// across ticks until its pending rows are exhausted.
export async function selectDrainableStages(
  dbc: typeof db,
  opts: { orgId?: string; maxStages: number },
): Promise<DrainableRow[]> {
  const { orgId, maxStages } = opts;
  return (await dbc.execute(sql`
    SELECT s.id              AS stage_id,
           c.org_id          AS org_id,
           s.sms_provider_id AS provider_id,
           p.max_sends_per_run AS max_sends_per_run
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE c.link_mode = 'tracked'
      AND c.status = 'active'
      AND s.send_approved = true
      AND s.archived_at IS NULL
      AND (p.send_paused IS NOT TRUE)
      AND EXISTS (
        SELECT 1 FROM stage_sends ss
        WHERE ss.stage_id = s.id AND ss.status = 'pending'
      )
      ${orgId ? sql`AND c.org_id = ${orgId}` : sql``}
    ORDER BY s.scheduled_at ASC NULLS LAST, s.id ASC
    LIMIT ${maxStages}
  `)) as unknown as DrainableRow[];
}

export interface ScheduledRunResult {
  considered: number; // due, un-materialized stages selected this run
  materialized: number; // stages whose kickoff succeeded this tick
  held: number; // window not open yet (retry next tick)
  missed: number; // window closed OR a permanent kickoff refusal -> marked missed
  refused: number; // transient kickoff failure / lost a materialize race -> retry
  drained: number; // stages whose drain ran this tick (phase B)
  budget_held: number; // provider's per-tick send budget exhausted -> not drained
  paused_skipped: number; // provider paused -> skipped
  send_disabled: boolean; // global kill-switch off -> whole run no-op'd
  sent: number; // total messages sent across stages
  failed: number; // total messages failed across stages
  paused_now: number; // stages whose drain latched a circuit-breaker pause
}

const BASE: ScheduledRunResult = {
  considered: 0,
  materialized: 0,
  held: 0,
  missed: 0,
  refused: 0,
  drained: 0,
  budget_held: 0,
  paused_skipped: 0,
  send_disabled: false,
  sent: 0,
  failed: 0,
  paused_now: 0,
};

// Kickoff refusals that won't self-resolve within the scheduled window — mark
// the stage missed so it stops retrying every tick and surfaces for a human.
// (`already_pending` is NOT here: it means another tick already materialized —
// a benign race, not a config error.)
const PERMANENT_REFUSALS: ReadonlySet<KickoffRefusal> = new Set([
  "not_found",
  "no_creative",
  "no_recipients",
  "stage_not_ready",
  "no_provider",
  "provider_not_api_capable",
  "no_credentials",
  "no_short_domain",
  "no_destination",
]);

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
    // Injectable for tests; defaults to the real per-stage drain. maxRows is the
    // stage's remaining slice of its provider's per-tick send budget.
    runDrain?: (stageId: number, maxRows: number) => Promise<DrainResult>;
  },
): Promise<ScheduledRunResult> {
  const now = opts?.now ?? new Date();
  const isEnabled = opts?.isEnabled ?? envSendEnabled;
  const sendSms = opts?.sendSms;
  const maxStages = opts?.maxStages ?? 50;
  const orgId = opts?.orgId;
  const runDrain =
    opts?.runDrain ??
    ((stageId: number, maxRows: number) =>
      runStageDrain(dbc, { stageId, sendSms, isEnabled, maxRows }));

  // Master kill-switch: with global sending off, no-op entirely — don't
  // materialize, don't drain, don't mark missed. Everything waits for the next
  // tick once enabled (subject to the same window/missed rules then).
  if (!isEnabled()) return { ...BASE, send_disabled: true };

  const result: ScheduledRunResult = { ...BASE };
  const nowIso = now.toISOString(); // raw execute can't bind a JS Date

  // Cross-stage per-run budget: max_sends_per_run is a per-PROVIDER pacing cap
  // for the WHOLE tick, not per stage. Shared across BOTH phases so N stages on
  // one provider can never exceed N× the cap in a single tick.
  const spentByProvider = new Map<number, number>();

  // ─── Phase A: materialize due stages ───────────────────────────────────────
  const due = await selectDueScheduledStages(dbc, { now, orgId, maxStages });
  result.considered = due.length;

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
      await dbc.execute(sql`
        UPDATE campaign_stages SET schedule_missed_at = ${nowIso}
        WHERE id = ${row.stage_id}
          AND sent_at IS NULL
          AND schedule_missed_at IS NULL
      `);
      result.missed++;
      continue;
    }

    // decision === "fire". Re-check the pause right before materializing.
    if (row.provider_id != null && (await isProviderPaused(dbc, row.provider_id))) {
      result.paused_skipped++;
      continue;
    }

    // Materialize. A thrown error (e.g. the dedup index firing on a concurrent
    // materialize race) is caught per-stage so one stage can't fail the whole
    // run; the stage simply retries next tick (its rows, if any, were rolled
    // back with the transaction).
    let kickoff: Awaited<ReturnType<typeof kickoffStageSend>> | null = null;
    try {
      kickoff = await dbc.transaction((tx) =>
        kickoffStageSend(tx, {
          orgId: row.org_id,
          campaignId: row.campaign_id,
          stageId: row.stage_id,
        }),
      );
    } catch {
      result.refused++;
      continue;
    }

    if (kickoff.ok || kickoff.reason === "already_pending") {
      // Stamp sent_at = "materialized & handed to the drain" (also locks the
      // stage's Scheduled field). Guarded so a concurrent claim isn't clobbered.
      await dbc.execute(sql`
        UPDATE campaign_stages SET sent_at = ${nowIso}
        WHERE id = ${row.stage_id} AND sent_at IS NULL
      `);
      result.materialized++;
    } else if (PERMANENT_REFUSALS.has(kickoff.reason)) {
      await dbc.execute(sql`
        UPDATE campaign_stages SET schedule_missed_at = ${nowIso}
        WHERE id = ${row.stage_id}
          AND sent_at IS NULL
          AND schedule_missed_at IS NULL
      `);
      result.missed++;
    } else {
      result.refused++;
    }
  }

  // ─── Phase B: drain stages with pending rows (incl. just-materialized) ──────
  const drainable = await selectDrainableStages(dbc, { orgId, maxStages });

  for (const row of drainable) {
    if (row.provider_id != null && (await isProviderPaused(dbc, row.provider_id))) {
      result.paused_skipped++;
      continue;
    }

    // Per-provider per-tick budget gate. Null-provider stages have no cap here;
    // their drain refuses (no_provider) anyway.
    let budget = Number.POSITIVE_INFINITY;
    const providerId = row.provider_id;
    if (providerId != null) {
      const cap = resolvePacingCap(row.max_sends_per_run);
      const remaining = cap - (spentByProvider.get(providerId) ?? 0);
      if (remaining <= 0) {
        result.budget_held++;
        continue;
      }
      budget = remaining;
    }

    const drain = await runDrain(row.stage_id, budget);
    result.drained++;
    result.sent += drain.sent;
    result.failed += drain.failed;
    if (drain.pausedNow) result.paused_now++;
    if (providerId != null) {
      spentByProvider.set(
        providerId,
        (spentByProvider.get(providerId) ?? 0) + drain.processed,
      );
    }
  }

  return result;
}
