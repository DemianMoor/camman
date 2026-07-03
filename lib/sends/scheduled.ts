import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import {
  decideScheduledSend,
  isOutsideSendWindow,
  type ProviderSendWindow,
} from "@/lib/quiet-hours";
import { isProviderPaused, resolvePacingCap } from "@/lib/sends/circuit-breakers";
import { runStageDrain, type DrainResult, type Sender } from "@/lib/sends/drain";
import { kickoffStageSend, type KickoffRefusal } from "@/lib/sends/kickoff";

// The send-scheduled cron. Two phases per tick, both bounded by the SAME
// per-provider per-tick send budget:
//
//   Phase A — MATERIALIZE: for each DUE, not-yet-materialized scheduled stage,
//     consult the provider's ET window (hold / missed / fire), then kickoff
//     (mint links + stage_sends rows). Phase A does NOT stamp `sent_at` — the
//     materialized rows themselves prevent re-materialization (the due-selection
//     requires NOT EXISTS stage_sends), and stamping before the drain would mark
//     a stage "Sent" even when the drain is later gate-refused (Bug 1). A tick
//     killed mid-materialize rolls the kickoff tx back (no rows) and retries.
//     Concurrency is guarded structurally by the `stage_sends_active_contact_uniq`
//     dedup index (two ticks materializing the same stage → one wins, the other's
//     INSERT raises 23505 and is caught), so no pre-claim is needed.
//
//   Phase B — DRAIN: any released-or-due tracked stage with `pending` stage_sends
//     is drained in a bounded batch (the provider's remaining per-tick budget).
//     `sent_at` is stamped here ONLY after a drain pass actually attempts ≥1 send
//     (processed > 0) — so a gate-refused stage stays armed and re-selectable,
//     never a false "Sent". This is what makes large audiences safe: sending is
//     RESUMABLE across ticks instead of pushing the whole audience inside one 300s
//     invocation. Just-materialized stages are picked up here in the same tick.

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

// Read-only selection of DUE stages that still need (more) materialization:
// tracked + active campaign, approved, scheduled in the past, not yet fired
// (sent_at NULL), not already missed, and NOT fully materialized yet
// (materialized_at IS NULL). Windowed materialization commits partial progress,
// so completeness is the materialized_at flag — NOT the mere existence of
// stage_sends rows. A partially-materialized stage is re-selected here and
// kickoff RESUMES it (materializing only the remaining recipients); once complete
// it stamps materialized_at and drops out. Exported for isolated tests.
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
      -- Not yet FULLY materialized (materialized_at IS NULL): fresh stages AND
      -- partially-materialized ones (resumed here). Fully-materialized stages
      -- drop out and are drained by Phase B.
      AND s.materialized_at IS NULL
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
  scheduled_at: string | null;
  sent_at: string | null;
  send_window_weekday_start: number | null;
  send_window_weekday_end: number | null;
  send_window_weekend_start: number | null;
  send_window_weekend_end: number | null;
}

// Read-only selection of tracked stages with `pending` sends that are eligible to
// drain THIS tick. Decoupled from materialization (WS2): a stage that was
// pre-materialized at approve-time for a FUTURE schedule must NOT drain until its
// time arrives. A stage is a candidate when it is either:
//   • already RELEASED (`sent_at` set) — first send happened, so keep draining
//     leftovers across ticks (the resumable-send feed), OR
//   • DUE for its first release (`scheduled_at <= now`) — Phase B then applies the
//     window decision per-stage (first-fire stamps sent_at).
// Future-armed stages (sent_at NULL, scheduled_at in the future) are excluded.
// The in-window gate is applied in JS in runScheduledSends (sender-zone, ET).
export async function selectDrainableStages(
  dbc: typeof db,
  opts: { now: Date; orgId?: string; maxStages: number },
): Promise<DrainableRow[]> {
  const { now, orgId, maxStages } = opts;
  const nowIso = now.toISOString();
  return (await dbc.execute(sql`
    SELECT s.id              AS stage_id,
           c.org_id          AS org_id,
           s.sms_provider_id AS provider_id,
           p.max_sends_per_run AS max_sends_per_run,
           s.scheduled_at    AS scheduled_at,
           s.sent_at         AS sent_at,
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
      AND s.archived_at IS NULL
      AND (p.send_paused IS NOT TRUE)
      -- NEVER drain a partially-materialized audience: only stages whose
      -- materialization is COMPLETE (materialized_at set) are drainable. Phase A
      -- finishes any in-progress materialization first.
      AND s.materialized_at IS NOT NULL
      -- Released already, OR due for first release. Future-armed stages
      -- (sent_at NULL and scheduled_at in the future) are held until due.
      AND (s.sent_at IS NOT NULL OR (s.scheduled_at IS NOT NULL AND s.scheduled_at <= ${nowIso}))
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
  drain_held: number; // due/released but outside the send window -> hold for next window
  budget_held: number; // provider's per-tick send budget exhausted -> not drained
  paused_skipped: number; // provider paused -> skipped
  send_disabled: boolean; // global kill-switch off -> whole run no-op'd
  sent: number; // total messages sent across stages
  failed: number; // total messages failed across stages
  skipped_duplicate: number; // numbers excluded by the global 1-hour dedup gate
  paused_now: number; // stages whose drain latched a circuit-breaker pause
}

const BASE: ScheduledRunResult = {
  considered: 0,
  materialized: 0,
  held: 0,
  missed: 0,
  refused: 0,
  drained: 0,
  drain_held: 0,
  budget_held: 0,
  paused_skipped: 0,
  send_disabled: false,
  sent: 0,
  failed: 0,
  skipped_duplicate: 0,
  paused_now: 0,
};

// Per-stage materialization budget for a cron tick. Windowed materialization
// commits per window, so a stage exceeding this just resumes next tick (its
// committed rows persist). Kept well under the route's 300s ceiling so one huge
// stage can't starve the whole tick — the rest resume next tick.
const MATERIALIZE_BUDGET_MS = 120_000;

// Kickoff refusals that won't self-resolve within the scheduled window — mark
// the stage missed so it stops retrying every tick and surfaces for a human.
const PERMANENT_REFUSALS: ReadonlySet<KickoffRefusal> = new Set([
  "not_found",
  "no_creative",
  "no_schedule",
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
    // DB master switch (org_settings.sends_enabled); forwarded to the per-stage
    // drain. Injectable for tests, same as isEnabled; defaults to the real read.
    isOrgEnabled?: (orgId: string) => Promise<boolean>;
    sendSms?: Sender;
    maxStages?: number;
    // Injectable for tests; defaults to the real per-stage drain. maxRows is the
    // stage's remaining slice of its provider's per-tick send budget.
    runDrain?: (stageId: number, maxRows: number) => Promise<DrainResult>;
  },
): Promise<ScheduledRunResult> {
  const now = opts?.now ?? new Date();
  const isEnabled = opts?.isEnabled ?? envSendEnabled;
  const isOrgEnabled = opts?.isOrgEnabled;
  const sendSms = opts?.sendSms;
  const maxStages = opts?.maxStages ?? 50;
  const orgId = opts?.orgId;
  const runDrain =
    opts?.runDrain ??
    ((stageId: number, maxRows: number) =>
      runStageDrain(dbc, { stageId, sendSms, isEnabled, isOrgEnabled, maxRows }));

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

    // Materialize (windowed + resumable — kickoff manages its own per-window
    // transactions, so it is NOT wrapped in one here). A thrown error is caught
    // per-stage so one stage can't fail the whole run; committed windows persist
    // and the stage resumes next tick. complete=false (budget hit) also just
    // resumes next tick (materialized_at stays NULL → re-selected by Phase A).
    let kickoff: Awaited<ReturnType<typeof kickoffStageSend>> | null = null;
    try {
      kickoff = await kickoffStageSend(dbc, {
        orgId: row.org_id,
        campaignId: row.campaign_id,
        stageId: row.stage_id,
        budgetMs: MATERIALIZE_BUDGET_MS,
      });
    } catch {
      result.refused++;
      continue;
    }

    if (kickoff.ok) {
      // Made materialization progress (complete or partial). Do NOT stamp sent_at
      // here (Bug 1 fix) — that means "a drain actually sent ≥1 message" and Phase
      // B stamps it. Phase B only drains once materialized_at is set (complete), so
      // a partially-materialized stage is never sent early.
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
  const drainable = await selectDrainableStages(dbc, { now, orgId, maxStages });

  for (const row of drainable) {
    if (row.provider_id != null && (await isProviderPaused(dbc, row.provider_id))) {
      result.paused_skipped++;
      continue;
    }

    // Per-provider per-tick budget gate FIRST — a budget-held stage must stay
    // fully untouched (no release stamp) so the next tick re-drains it cleanly.
    // Null-provider stages have no cap here; their drain refuses (no_provider).
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

    // Window gate (WS2 decoupling). Two cases:
    //   • FIRST FIRE (sent_at NULL, due): apply the day-anchored decision so a send
    //     never rolls to a later calendar day — hold before the window, mark missed
    //     after it closes, fire inside it.
    //   • CONTINUATION (sent_at set): leftovers of an already-released send (incl.
    //     send-now). Drain only while NOW is inside the window; outside it, hold for
    //     the next window (resumable across days — never stranded, never out-of-hours).
    const cfg: ProviderSendWindow = {
      send_window_weekday_start: row.send_window_weekday_start,
      send_window_weekday_end: row.send_window_weekday_end,
      send_window_weekend_start: row.send_window_weekend_start,
      send_window_weekend_end: row.send_window_weekend_end,
    };
    const firstFire = row.sent_at == null;
    if (firstFire) {
      // First release of a due scheduled stage. Do NOT stamp sent_at yet — that
      // happens only AFTER a drain pass actually sends (Bug 1 fix below).
      const decision = row.scheduled_at
        ? decideScheduledSend(cfg, new Date(row.scheduled_at), now)
        : "fire";
      if (decision === "hold") {
        result.drain_held++;
        continue;
      }
      if (decision === "missed") {
        await dbc.execute(sql`
          UPDATE campaign_stages SET schedule_missed_at = ${nowIso}
          WHERE id = ${row.stage_id} AND sent_at IS NULL AND schedule_missed_at IS NULL
        `);
        result.missed++;
        continue;
      }
      // decision === "fire": fall through to the drain.
    } else if (isOutsideSendWindow(cfg, now)) {
      // Released stage, but the window is currently closed — hold the leftovers.
      result.drain_held++;
      continue;
    }

    const drain = await runDrain(row.stage_id, budget);
    result.drained++;
    result.sent += drain.sent;
    result.failed += drain.failed;
    result.skipped_duplicate += drain.skippedDuplicate;
    if (drain.pausedNow) result.paused_now++;
    if (providerId != null) {
      spentByProvider.set(
        providerId,
        (spentByProvider.get(providerId) ?? 0) + drain.processed,
      );
    }

    // Bug 1 fix — INTEGRITY: stamp the release marker (sent_at) IF AND ONLY IF the
    // drain actually attempted ≥1 send (processed > 0 ⇒ rows transitioned to
    // 'sending'). A gate-refused drain (env SEND_ENABLED off, DB sends_enabled
    // off, send_paused, or any other refusal) returns processed 0 and leaves
    // sent_at NULL, so the stage looks identical to "armed, not yet fired" and is
    // re-selected on the next tick once the gate opens — never a false "Sent".
    if (firstFire && drain.processed > 0) {
      await dbc.execute(sql`
        UPDATE campaign_stages SET sent_at = ${nowIso}
        WHERE id = ${row.stage_id} AND sent_at IS NULL
      `);
    }
  }

  return result;
}
