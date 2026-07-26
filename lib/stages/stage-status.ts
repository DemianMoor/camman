// WS4 §0 — the single operational-status model for campaign stages.
//
// This is the ONE source of truth for the five-state "will it send?" lifecycle
// that colors stage rows, the campaign-level legend, and the fleet dashboard.
// Change a state once here and every surface updates. Do NOT hardcode these
// colors/labels anywhere else — import from this module.
//
// IMPORTANT — this is DISTINCT from the user-editable `status` column on
// campaign_stages (draft/pending/sent/success/cancelled/failed), which is a
// manual record the operator keeps for campaign results. The operational status
// below is DERIVED from the send pipeline (schedule + materialized stage_sends)
// and answers a different question: "is this stage actually going to fire?".
//
// The Orange↔Blue split is the entire point: it is driven by MATERIALIZATION
// (whether stage_sends rows exist), NOT by whether scheduled_at is set. A
// scheduled stage with no materialized rows reads Orange ("won't send until you
// Prepare it"); once Prepared (rows exist) it reads Blue.

export type StageOperationalStatus =
  | "draft"
  | "scheduled_unprepared"
  | "held"
  | "blocked"
  | "materializing"
  | "prepared"
  | "sending_sent"
  | "missed_failed";

// "Will it send?" summarized for copy/sorting. `attention` and `unprepared`
// are the two that must read loud — they mean "this will NOT send as-is".
export type WillSend = "no" | "unprepared" | "yes" | "sent" | "attention";

export interface StageStatusMeta {
  key: StageOperationalStatus;
  label: string;
  /** One-line, operator-facing meaning. Reused verbatim by the legend. */
  meaning: string;
  willSend: WillSend;
  /** Sort weight for "surface the ones needing action first" (lower = higher priority). */
  sortWeight: number;
  /** Badge/pill: border + bg + text. */
  badgeClass: string;
  /** Small status dot: bg only. */
  dotClass: string;
  /** Subtle list-row tint: left accent border + faint bg. */
  rowClass: string;
  /** Solid legend swatch: bg only. */
  swatchClass: string;
}

export const STAGE_STATUS_META: Record<StageOperationalStatus, StageStatusMeta> = {
  draft: {
    key: "draft",
    label: "Draft",
    meaning: "Not scheduled or not configured yet.",
    willSend: "no",
    sortWeight: 40,
    badgeClass:
      "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
    dotClass: "bg-slate-400",
    rowClass: "border-l-slate-300 dark:border-l-slate-700",
    swatchClass: "bg-slate-400",
  },
  scheduled_unprepared: {
    key: "scheduled_unprepared",
    label: "Scheduled, not prepared",
    meaning:
      "Time is set but messages aren't prepared — will NOT send until you Prepare it.",
    willSend: "unprepared",
    sortWeight: 0,
    badgeClass:
      "border-orange-300 bg-orange-100 text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200",
    dotClass: "bg-orange-500",
    rowClass: "border-l-orange-500 bg-orange-50/40 dark:bg-orange-950/20",
    swatchClass: "bg-orange-500",
  },
  materializing: {
    key: "materializing",
    label: "Materializing",
    meaning:
      "Preparing messages in the background — resumes automatically and will be ready to send shortly. (Large audiences finish across a few cron ticks.)",
    willSend: "yes",
    sortWeight: 10,
    badgeClass:
      "border-indigo-300 bg-indigo-100 text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200",
    dotClass: "bg-indigo-500 animate-pulse",
    rowClass: "border-l-indigo-500 bg-indigo-50/40 dark:bg-indigo-950/20",
    swatchClass: "bg-indigo-500",
  },
  prepared: {
    key: "prepared",
    label: "Prepared",
    meaning: "Approved and prepared — will send automatically at the scheduled time.",
    willSend: "yes",
    sortWeight: 20,
    badgeClass:
      "border-blue-300 bg-blue-100 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200",
    dotClass: "bg-blue-500",
    rowClass: "border-l-blue-500 bg-blue-50/40 dark:bg-blue-950/20",
    swatchClass: "bg-blue-500",
  },
  sending_sent: {
    key: "sending_sent",
    label: "Sending / Sent",
    meaning: "Messages submitted to the provider.",
    willSend: "sent",
    sortWeight: 30,
    badgeClass:
      "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
    dotClass: "bg-emerald-500",
    rowClass: "border-l-emerald-500 dark:border-l-emerald-600",
    swatchClass: "bg-emerald-500",
  },
  held: {
    key: "held",
    label: "Held (awaiting action)",
    meaning:
      "A lane child parked at the 24h slip cap — its parent didn't finish in time. Will NOT send until you re-date or cancel it.",
    willSend: "attention",
    sortWeight: 0,
    badgeClass:
      "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
    dotClass: "bg-amber-500",
    rowClass: "border-l-amber-500 bg-amber-50/50 dark:bg-amber-950/25",
    swatchClass: "bg-amber-500",
  },
  blocked: {
    key: "blocked",
    label: "Blocked — campaign send paused",
    meaning:
      "The campaign's send circuit is latched (opt-out-rate breaker, or a manual pause). Nothing on this campaign sends until a human resumes it.",
    willSend: "attention",
    sortWeight: 0,
    badgeClass:
      "border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200",
    dotClass: "bg-rose-500",
    rowClass: "border-l-rose-500 bg-rose-50/50 dark:bg-rose-950/25",
    swatchClass: "bg-rose-500",
  },
  missed_failed: {
    key: "missed_failed",
    label: "Missed / Failed",
    meaning:
      "Scheduled time passed without sending, or sends failed — needs attention.",
    willSend: "attention",
    sortWeight: 0,
    badgeClass:
      "border-red-300 bg-red-100 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
    dotClass: "bg-red-500",
    rowClass: "border-l-red-500 bg-red-50/50 dark:bg-red-950/25",
    swatchClass: "bg-red-500",
  },
};

// Ordered for the legend (lifecycle order, not sort weight).
export const STAGE_STATUS_ORDER: StageOperationalStatus[] = [
  "draft",
  "scheduled_unprepared",
  "held",
  "blocked",
  "materializing",
  "prepared",
  "sending_sent",
  "missed_failed",
];

export interface StageSendCounts {
  total: number;
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  // Rows excluded by the global 1-hour send-dedup gate (migration 0090). Terminal:
  // never sent, never opted-out. Surfaced as a warning, not counted as sent.
  skippedDuplicate: number;
}

export interface DeriveStageStatusInput {
  /** Campaign link mode. Only "tracked" stages ride the materialization pipeline. */
  linkMode?: string | null;
  /** Manual status column — used only to detect "archived" (off the model). */
  status?: string | null;
  scheduledAt: string | Date | null;
  sentAt: string | Date | null;
  scheduleMissedAt: string | Date | null;
  /** campaign_stages.slip_hold_at (migration 0117) — a lane child parked at the
   *  24h slip cap. Takes precedence over the scheduled/unprepared reading. */
  slipHoldAt?: string | Date | null;
  /** campaigns.send_paused (migration 0119) — the per-campaign send circuit is
   *  latched, so BOTH scheduler phases skip every stage on this campaign. */
  campaignSendPaused?: boolean | null;
  /** campaign_stages.materialized_at — set only when EVERY recipient row exists.
   *  NULL while windowed materialization is in progress (some rows may exist). */
  materializedAt: string | Date | null;
  /** stage_sends counts by status. Null/absent ⇒ nothing materialized. */
  counts: StageSendCounts | null | undefined;
}

const EMPTY_COUNTS: StageSendCounts = {
  total: 0,
  pending: 0,
  sending: 0,
  sent: 0,
  failed: 0,
  skippedDuplicate: 0,
};

/**
 * Derive the operational status for a stage, or `null` when the stage is not on
 * the send pipeline (manual-mode campaigns, archived stages) — callers fall back
 * to the manual-status color in that case.
 *
 * Precedence (tracked stages):
 *  1. schedule_missed_at set                  → missed_failed (Red)
 *  1a. campaign send circuit latched, work left → blocked      (Rose)
 *  1b. slip-held lane child                   → held          (Amber)
 *  2. materialized, drain done with failures  → missed_failed (Red)
 *  3. some sent / actively sending            → sending_sent  (Green)
 *  4. materialized, nothing sent yet          → prepared      (Blue)
 *  5. scheduled but nothing materialized      → scheduled_unprepared (Orange)
 *  6. otherwise                               → draft         (Grey)
 */
export function deriveStageOperationalStatus(
  input: DeriveStageStatusInput,
): StageOperationalStatus | null {
  // Only the tracked (API-send) pipeline materializes stage_sends, so only it
  // has a real Orange↔Blue distinction. Manual campaigns keep their manual
  // status color; archived stages are off the model entirely.
  if (input.linkMode != null && input.linkMode !== "tracked") return null;
  if (input.status === "archived") return null;

  const c = input.counts ?? EMPTY_COUNTS;
  const hasRows = c.total > 0;

  // 1. A missed scheduled window is always "needs attention" — must never read
  //    Green/Sent (Bug 1 makes schedule_missed_at trustworthy).
  if (input.scheduleMissedAt != null) return "missed_failed";

  // 1a. The CAMPAIGN's send circuit is latched (campaigns.send_paused — the P7
  //     opt-out-rate breaker or a manual pause). Both scheduler phases filter on
  //     `c.send_paused IS NOT TRUE`, so nothing on this campaign materializes or
  //     drains — and, because the pause gate sits UPSTREAM of the code that
  //     stamps schedule_missed_at, a due stage doesn't even go Red. Without this
  //     state it renders as an ordinary Blue "Prepared" card and the pause is
  //     invisible (the 2026-07-25 incident presented exactly that way).
  //     Precedence: below a genuinely missed window (the louder, less
  //     recoverable fact), above the lane slip-hold (while the campaign is
  //     paused, releasing a hold changes nothing — the campaign latch is the
  //     binding constraint).
  //     Only stages with OUTSTANDING work are blocked. A stage that already
  //     finished sending is unaffected by a later pause; calling it "Blocked"
  //     would mis-state history and inflate the dashboards' held-message counts.
  if (
    input.campaignSendPaused === true &&
    (c.pending > 0 || c.sending > 0 || (!hasRows && input.scheduledAt != null))
  ) {
    return "blocked";
  }

  // 1b. A slip-held lane child (24h cap) is parked awaiting a human — it will NOT
  //     fire (the cron's `slip_hold_at IS NULL` gate excludes it). Must not read as
  //     Orange "scheduled" (it won't self-resolve). Precedence over everything but
  //     a genuine missed window and a campaign-level pause.
  if (input.slipHoldAt != null) return "held";

  // 1c. Materialization in progress: rows are being written in committed windows
  //     but materialized_at isn't set yet, so the audience is INCOMPLETE and must
  //     NOT read "Prepared" (it can't send until complete). Distinct Indigo state
  //     so the operator sees steady progress instead of a stalled/timed-out spinner.
  if (input.materializedAt == null && hasRows) return "materializing";

  if (hasRows) {
    // 2. The bulk went out. As long as ANY message was sent (or is actively being
    //    submitted), the stage reads Green "Sent" — a handful of failed / stuck-
    //    'sending' / dedup-skipped rows is a WARNING surfaced separately
    //    (stageSendWarningCount), NOT a whole-stage failure. Stuck 'sending' rows
    //    are converted to 'failed' by the reconciliation pass within ~15 min, so a
    //    genuinely dead stage (nothing sent) lands in case 4 below, not here.
    if (c.sent > 0 || c.sending > 0) return "sending_sent";
    // 3. Materialized and waiting (Prepared / Blue) — the WS4 non-negotiable.
    if (c.pending > 0) return "prepared";
    // 4. Terminal (nothing pending or sending) with NOTHING sent, but failures or
    //    dedup-skips → the stage genuinely didn't deliver → needs attention (Red).
    if (c.failed > 0 || c.skippedDuplicate > 0) return "missed_failed";
    // Fully drained, zero sent, zero failed — nothing left; treat as sent.
    return "sending_sent";
  }

  // 5. Time set, nothing prepared → Orange (the live-test trap).
  if (input.scheduledAt != null) return "scheduled_unprepared";
  // 6. Nothing scheduled, nothing prepared.
  return "draft";
}

// Recipients that did NOT get the message even though the stage sent: hard
// failures + rows stranded in 'sending' (interrupted drain, pending reconciliation)
// + rows the 1-hour dedup gate skipped. Surfaced as a "N not delivered" warning
// next to a Green stage — the counterpart to no longer flipping the whole stage
// Red when the bulk sent. Zero for a clean or not-yet-materialized stage.
export function stageSendWarningCount(
  counts: StageSendCounts | null | undefined,
): number {
  const c = counts ?? EMPTY_COUNTS;
  return c.failed + c.sending + c.skippedDuplicate;
}
