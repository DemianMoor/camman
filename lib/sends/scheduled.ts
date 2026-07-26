import { sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";

import type { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { CAMPAIGN_TIMEZONE, CAMPAIGN_TIMEZONE_LABEL } from "@/lib/campaign-timezone";
import { withKeyedLease } from "@/lib/cron/keyed-lease";
import {
  decideScheduledSend,
  isOutsideSendWindow,
  type ProviderSendWindow,
} from "@/lib/quiet-hours";
import { decideChildSlip } from "@/lib/sends/child-slip";
import {
  isProviderPaused,
  makeSentSinceMemo,
  resolvePacingCap,
  resolveSendsPerSecond,
  type SentSinceMemo,
} from "@/lib/sends/circuit-breakers";
import { runStageDrain, type DrainResult, type Sender } from "@/lib/sends/drain";
import { kickoffStageSend, type KickoffRefusal } from "@/lib/sends/kickoff";
import { makeTokenBucket, type TokenBucket } from "@/lib/sends/token-bucket";

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
  // P4 lane-child gate: parent + slip state (NULL/0 for non-lane stages).
  parent_stage_id: number | null;
  slip_original_scheduled_at: string | null;
  slip_count: number;
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
           s.parent_stage_id AS parent_stage_id,
           s.slip_original_scheduled_at AS slip_original_scheduled_at,
           s.slip_count      AS slip_count,
           p.send_window_weekday_start AS send_window_weekday_start,
           p.send_window_weekday_end   AS send_window_weekday_end,
           p.send_window_weekend_start AS send_window_weekend_start,
           p.send_window_weekend_end   AS send_window_weekend_end
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE c.link_mode = 'tracked'
      AND c.status = 'active'
      -- P7/P8: per-campaign opt-out-rate breaker. Additive next to the per-provider
      -- latch (p.send_paused) — a paused provider still freezes all its campaigns;
      -- this only ever ADDS freezes within a still-live provider.
      AND (c.send_paused IS NOT TRUE)
      AND s.send_approved = true
      AND s.scheduled_at IS NOT NULL
      AND s.scheduled_at <= ${nowIso}
      AND s.sent_at IS NULL
      AND s.schedule_missed_at IS NULL
      -- P4: a lane child parked at the 24h slip cap must not be reselected.
      AND s.slip_hold_at IS NULL
      -- P5: an operator abort during the preflight window holds the stage.
      AND s.preflight_aborted_at IS NULL
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
  // The send-from phone. Phase B partitions the drain by this so stages on
  // different numbers drain CONCURRENTLY (a slow phone never blocks a fast one).
  provider_phone_id: number | null;
  // The PHONE's carrier rate. Selected here (not just inside runStageDrain) so
  // Phase B can build ONE shared token bucket per phone group and size the
  // provider-budget reservation proportionally.
  max_sends_per_second: number | null;
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
           s.provider_phone_id AS provider_phone_id,
           pp.max_sends_per_second AS max_sends_per_second,
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
    LEFT JOIN provider_phones pp ON pp.id = s.provider_phone_id
    WHERE c.link_mode = 'tracked'
      AND c.status = 'active'
      -- P7/P8: per-campaign opt-out-rate breaker. Additive next to the per-provider
      -- latch (p.send_paused) — a paused provider still freezes all its campaigns;
      -- this only ever ADDS freezes within a still-live provider.
      AND (c.send_paused IS NOT TRUE)
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
  slip_slipped: number; // lane children re-dated this tick (parent not yet complete)
  slip_waiting: number; // lane children still waiting on their parent (within 24h cap)
  slip_held: number; // lane children parked at the 24h slip cap (hold + alert)
  sent: number; // total messages sent across stages
  failed: number; // total messages failed across stages
  skipped_duplicate: number; // numbers excluded by the global 1-hour dedup gate
  skipped_opted_out: number; // recipients suppressed at dispatch (STOP after materialization)
  paused_now: number; // stages whose drain latched a circuit-breaker pause
  phone_lease_skipped: number; // phone groups skipped — another invocation is draining that number
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
  slip_slipped: 0,
  slip_waiting: 0,
  slip_held: 0,
  sent: 0,
  failed: 0,
  skipped_duplicate: 0,
  skipped_opted_out: 0,
  paused_now: 0,
  phone_lease_skipped: 0,
};

// Per-stage materialization budget for a cron tick. Windowed materialization
// commits per window, so a stage exceeding this just resumes next tick (its
// committed rows persist). Kept well under the route's 300s ceiling so one huge
// stage can't starve the whole tick — the rest resume next tick.
const MATERIALIZE_BUDGET_MS = 120_000;

// ─── Phase B fairness (head-of-line-blocking fix, then the starvation fix) ───
// Phase B originally drained stages sequentially (ORDER BY scheduled_at, id), so
// the FIRST stage consumed the whole ~300s invocation at its own number's rate
// and starved every stage behind it — one 3/s stage held ~60K messages on 60/s
// short codes hostage for 41 minutes (live 2026-07-24). That was fixed by
// partitioning by PHONE and draining the groups concurrently, plus round-robining
// same-phone stages in PER_STAGE_DRAIN_MS (20s) slices.
//
// The round-robin fixed *ordering* but not *rate*: within one phone group only
// ONE stage ran at a time, so a phone shared by several stages could never
// exceed one stage's throughput no matter how many were waiting — measured, a
// same-phone stage starved to 3.02 msg/s (24 drain sessions of ~18s separated by
// 68–282s gaps). Same-phone stages now drain CONCURRENTLY too, sharing ONE
// per-phone token bucket: the carrier rate is enforced by the bucket (where the
// limit actually lives — the number), not by serializing stages. So the 20s
// round-robin slice is gone; a stage's only wall-clock bound is the phase
// deadline.
//
// PHASE_B_DEADLINE_MS is the whole phase's budget, measured from run start.
// Raised 240s → 270s: with the job now leased per phone (an overrun tick can no
// longer double-send on a number), the old 60s of head-room under the route's
// 300s maxDuration is no longer buying safety, it is just idle time. The live
// 14-day histogram showed exactly that — sends by minute-of-cycle ran +0m
// 136,647 / +1m 169,011 / +2m 169,922 / +3m 163,018 / +4m 127,294: minute +4
// collapses because the phase stops at 240s. 270s recovers half of it while
// still reserving ~30s for reconcileStuckStages (which runs AFTER this in the
// same route) plus the JSON response. The cron stays `*/5`: a 300s period with a
// 270s phase leaves a 30s settling gap, and shortening the period would only
// multiply cold starts + preamble work for the same fixed send rate.
const PHASE_B_DEADLINE_MS = 270_000;

// Max stages drained CONCURRENTLY within ONE phone group. They share the phone's
// single token bucket, so this does NOT raise the number's emitted rate — it
// only stops one stage from monopolizing the number while its siblings idle.
// Bounded because each concurrent stage is a live drain loop holding DB
// statements; 3 is enough to interleave a small set of same-phone stages without
// multiplying the pooler load (see db/client.ts `max`).
const STAGE_CONCURRENCY_PER_PHONE = 3;

// Max phone-groups drained CONCURRENTLY (Phase 1: phone-partitioned drain). Each
// group is internally sequential (one connection at a time) so this bounds the
// pool connections and outbound-HTTP fan-out. In practice only a handful of
// distinct phones have pending work at once, so this cap rarely binds — it's a
// safety bound, not a target.
const GROUP_CONCURRENCY = 8;

// ─── Per-phone drain lease (overlapping-invocation guard) ────────────────────
// The send-scheduled cron took NO lease, so a tick that overran its 300s
// maxDuration overlapped the next one and TWO drain loops sent on the SAME
// number simultaneously — the per-phone `max_sends_per_second` pacing is
// per-invocation, so N overlapping invocations multiply the effective MPS by N.
// That is a carrier-compliance exposure, safe today only by arithmetic accident
// (measured 2 × ~20/s = ~40/s against a 60/s configured number).
//
// The guard is PER PHONE, not per job: two invocations must never drain the same
// NUMBER concurrently, but different numbers must still proceed in parallel
// (that concurrency is the 2026-07-24 head-of-line fix and must not regress).
//
// Mechanism: a `cron_locks` lease ROW (lib/cron/lease.ts), NOT a Postgres
// advisory lock. `DATABASE_URL` targets Supavisor's TRANSACTION pooler (:6543,
// prepare=false), where a session advisory lock can be lost or stranded when the
// pooler reassigns the backend between statements — the same reasoning already
// documented on `withCronLease` and the Telnyx worker lease. A transaction-scoped
// advisory lock would be pooler-safe but would force the whole multi-minute drain
// into ONE long transaction holding one connection, which is exactly what the
// per-window-commit resumable design avoids. The lease row also gives free
// observability (`skipped_count` / `last_skipped_at` per phone).
//
// TTL SAFETY (a stuck lease that blocks all sending is worse than the bug):
// expiry is absolute (`lease_until < now()`), so a crashed/killed invocation's
// lease self-clears — no heartbeat, no manual cleanup. The value is
// PHASE_B_DEADLINE_MS, which is provably ≥ the work it protects: the deadline is
// measured from RUN start while the lease starts at GROUP start (always ≥ run
// start), so `groupStart + TTL ≥ runStart + PHASE_B_DEADLINE_MS` = the last
// instant any group can still be draining. A clean exit releases it immediately
// in `finally`; the TTL only ever matters after a hard kill, and one cron period
// (300s) > TTL (240s) guarantees the very next tick can reclaim the phone.
const PHONE_DRAIN_LEASE_MS = PHASE_B_DEADLINE_MS;

// Lease key for a Phase-B drain group. Stages on a phone share one key; a stage
// with NO phone gets its own (nothing else can contend for a number it doesn't
// have). Exported so tests can pre-seed / inspect the lease row.
export function phoneDrainLeaseKey(providerPhoneId: number | null, stageId: number): string {
  return providerPhoneId != null ? `send-drain:p${providerPhoneId}` : `send-drain:s${stageId}`;
}

// Per-reservation slice of a provider's per-tick send budget (max_sends_per_run).
//
// RE-DERIVED. The old flat 5,000 was sized against the retired 20s round-robin
// slice: a stage could only do rate×20s ≈ 1,200 rows per turn, so 5,000 was a
// comfortable over-grant. With the round-robin gone a single drain call now runs
// until the PHASE deadline, i.e. up to rate×270s ≈ 16,200 rows on a 60/s phone —
// a flat 5,000 would be re-reserved constantly at high rates and would still be
// a wild over-grant at 3/s (5,000 rows is ~28 minutes of a toll-free's output,
// so ONE slow stage would reserve a provider's whole per-tick cap and starve its
// siblings). Sizing the reservation as ~BUDGET_RESERVE_SECONDS of the phone's
// OWN sending makes it proportional at every rate: ~8 reservations across a
// 270s phase, frequent enough that concurrent same-provider groups interleave,
// rare enough that the in-memory reserve/release is noise. Clamped so a
// pathological rate can't produce a degenerate grant.
const BUDGET_RESERVE_SECONDS = 30;
const MIN_BUDGET_RESERVE = 200;
const MAX_BUDGET_RESERVE = 5_000;

function budgetReserveFor(sendsPerSecond: number): number {
  const wanted = Math.floor(sendsPerSecond * BUDGET_RESERVE_SECONDS);
  return Math.min(MAX_BUDGET_RESERVE, Math.max(MIN_BUDGET_RESERVE, wanted));
}

// Per-provider per-tick send budget as a SHARED, ATOMIC reservation. reserve()
// and release() are synchronous (no await between read and write), so concurrent
// phone groups on the same provider can never overshoot the cap — no lock needed
// (JS is single-threaded; the danger is only read-await-write, which we avoid).
function makeProviderBudget() {
  const spent = new Map<number, number>();
  return {
    // Grant up to `want`, bounded by the provider's remaining cap. Returns the
    // amount actually reserved (0 when the cap is exhausted).
    reserve(providerId: number, cap: number, want: number): number {
      const used = spent.get(providerId) ?? 0;
      const grant = Math.max(0, Math.min(cap - used, want));
      if (grant > 0) spent.set(providerId, used + grant);
      return grant;
    },
    // Hand back an unused (or over-) reservation after a drain returns.
    release(providerId: number, amount: number): void {
      if (amount <= 0) return;
      spent.set(providerId, Math.max(0, (spent.get(providerId) ?? 0) - amount));
    },
  };
}

// Bounded-concurrency worker pool: runs `fn` over `items` with at most `limit`
// in flight. A rejecting `fn` propagates (callers guard their own errors).
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

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
  "multi_segment_not_allowed",
  "segment_ceiling_exceeded",
  "no_sender_number",
]);

function envSendEnabled(): boolean {
  return process.env.SEND_ENABLED === "true";
}

// P4 parent-completeness: a parent lane-parent is COMPLETE once it has released
// (sent_at set) AND has no non-terminal stage_sends rows left. 'sending' counts
// as non-terminal so a child never materializes against a parent still mid-flight
// or with rows stranded by a mid-drain pause (reconcileStuckStages later resolves
// stranded 'sending' → 'failed', at which point completeness can hold). 'failed'
// and 'skipped_*' are terminal and do NOT block — one failed number never stalls
// the child (and the lane aliveness filter excludes it, since it matches on
// status='sent' only).
export async function getParentState(
  dbc: typeof db,
  parentStageId: number,
): Promise<{ scheduledAt: Date | null; complete: boolean }> {
  const rows = (await dbc.execute(sql`
    SELECT s.scheduled_at AS scheduled_at,
           s.sent_at      AS sent_at,
           NOT EXISTS (
             SELECT 1 FROM stage_sends ss
             WHERE ss.stage_id = s.id AND ss.status IN ('pending', 'sending')
           ) AS no_open
    FROM campaign_stages s
    WHERE s.id = ${parentStageId}
    LIMIT 1
  `)) as unknown as { scheduled_at: string | null; sent_at: string | null; no_open: boolean }[];
  const r = rows[0];
  return {
    scheduledAt: r?.scheduled_at ? new Date(r.scheduled_at) : null,
    complete: !!r && r.sent_at != null && r.no_open === true,
  };
}

// Human-readable identity for a slip/hold Telegram alert (fetched only when we
// actually slip or hold a lane child — rare, so a small extra query is fine).
async function getStageAlertContext(
  dbc: typeof db,
  stageId: number,
): Promise<{ campaign: string; stageNumber: number | null; label: string | null; trackingId: string | null }> {
  const rows = (await dbc.execute(sql`
    SELECT c.name AS campaign, s.stage_number AS stage_number,
           s.label AS label, s.tracking_id AS tracking_id
    FROM campaign_stages s JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.id = ${stageId} LIMIT 1
  `)) as unknown as {
    campaign: string | null; stage_number: number | null; label: string | null; tracking_id: string | null;
  }[];
  const r = rows[0];
  return {
    campaign: r?.campaign ?? "(unknown campaign)",
    stageNumber: r?.stage_number ?? null,
    label: r?.label ?? null,
    trackingId: r?.tracking_id ?? null,
  };
}

function fmtEt(d: Date): string {
  return `${formatInTimeZone(d, CAMPAIGN_TIMEZONE, "yyyy-MM-dd HH:mm")} ${CAMPAIGN_TIMEZONE_LABEL}`;
}

function stageLine(
  ctx: Awaited<ReturnType<typeof getStageAlertContext>>,
  row: DueRow,
): string {
  const stageBit = ctx.stageNumber != null ? `stage ${ctx.stageNumber}` : `stage id ${row.stage_id}`;
  const labelBit = ctx.label ? ` "${ctx.label}"` : "";
  const trackBit = ctx.trackingId ? ` [${ctx.trackingId}]` : "";
  return `campaign "${ctx.campaign}" · ${stageBit}${labelBit}${trackBit} (id ${row.stage_id})`;
}

// Slip alert — MUST include the new fire time (spec requirement).
async function notifySlip(dbc: typeof db, row: DueRow, newFireAt: Date): Promise<void> {
  const ctx = await getStageAlertContext(dbc, row.stage_id);
  await notifyTelegram(
    `🕒 Lane stage SLIPPED — waiting on its parent to finish sending.\n` +
      `${stageLine(ctx, row)}\n` +
      `New fire time: ${fmtEt(newFireAt)}\n` +
      `The parent hasn't fully sent yet; the child was re-dated to preserve its intended gap.`,
  );
}

// Hold alert — self-sufficient (campaign, stage, original time, reason, action).
async function notifyHold(
  dbc: typeof db,
  row: DueRow,
  reason: "slip_cap_exceeded" | "parent_incomplete_24h",
  originalScheduledAt: Date,
): Promise<void> {
  const ctx = await getStageAlertContext(dbc, row.stage_id);
  const why =
    reason === "parent_incomplete_24h"
      ? "its parent stage has NOT finished sending 24h+ after the child's scheduled time (e.g. a paused/stalled provider freezing the parent's remaining sends)"
      : "re-dating the child to preserve its parent→child gap would push it more than 24h past its original scheduled time";
  await notifyTelegram(
    `⏸️ Lane stage HELD — will NOT auto-send (24h slip cap reached).\n` +
      `${stageLine(ctx, row)}\n` +
      `Originally scheduled: ${fmtEt(originalScheduledAt)}\n` +
      `Reason: ${why}.\n` +
      `Action needed: resolve the parent (resume its provider / let it finish), then re-date this lane manually, or cancel it. It stays parked until a human acts.`,
  );
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
    // stage's remaining slice of its provider's per-tick send budget;
    // maxDurationMs is the wall-clock left in the phase; `shared` carries the
    // per-phone pacer + the invocation-wide dedup set and 24h-count memo.
    runDrain?: (
      stageId: number,
      maxRows: number,
      maxDurationMs?: number,
      shared?: { bucket: TokenBucket; seenPhones: Set<string>; sentSinceMemo: SentSinceMemo },
    ) => Promise<DrainResult>;
  },
): Promise<ScheduledRunResult> {
  const now = opts?.now ?? new Date();
  // Real wall-clock anchor for Phase B fairness time-boxing. Separate from `now`
  // (logical/injectable time used for scheduling decisions) — this measures how
  // long the invocation has actually run so the phase can stop with margin under
  // the route's 300s ceiling.
  const runStartedAt = Date.now();
  const isEnabled = opts?.isEnabled ?? envSendEnabled;
  const isOrgEnabled = opts?.isOrgEnabled;
  const sendSms = opts?.sendSms;
  const maxStages = opts?.maxStages ?? 50;
  const orgId = opts?.orgId;
  const runDrain =
    opts?.runDrain ??
    ((
      stageId: number,
      maxRows: number,
      maxDurationMs?: number,
      shared?: { bucket: TokenBucket; seenPhones: Set<string>; sentSinceMemo: SentSinceMemo },
    ) =>
      runStageDrain(dbc, {
        stageId, sendSms, isEnabled, isOrgEnabled, maxRows, maxDurationMs,
        bucket: shared?.bucket,
        seenPhones: shared?.seenPhones,
        sentSinceMemo: shared?.sentSinceMemo,
      }));
  // INVOCATION-WIDE, shared by every stage on every phone in this tick:
  //  • seenPhones — org-scoped in-flight dedup set. The 1-hour gate's committed
  //    'sent' probe can't see a sibling slice's not-yet-committed dispatch, and
  //    slices are now genuinely concurrent both within a phone and across
  //    phones, so the set has to outlive a single batch (and a single stage).
  //  • sentSinceMemo — the 24h rolling count (the drain's slowest statement).
  const seenPhones = new Set<string>();
  const sentSinceMemo = makeSentSinceMemo();

  // Master kill-switch: with global sending off, no-op entirely — don't
  // materialize, don't drain, don't mark missed. Everything waits for the next
  // tick once enabled (subject to the same window/missed rules then).
  if (!isEnabled()) return { ...BASE, send_disabled: true };

  const result: ScheduledRunResult = { ...BASE };
  const nowIso = now.toISOString(); // raw execute can't bind a JS Date

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

    // ─── P4: parent-complete gate for lane children ────────────────────────
    // A due lane child (parent_stage_id set) must not materialize until its
    // parent has fully sent. While the parent is incomplete the child is slipped
    // (re-dated) / waited / held; only a 'fire' falls through to the normal
    // window decision below. Non-lane stages skip this entirely.
    if (row.parent_stage_id != null) {
      const parent = await getParentState(dbc, row.parent_stage_id);
      const action = decideChildSlip({
        now,
        childScheduledAt: new Date(row.scheduled_at),
        slipOriginalScheduledAt: row.slip_original_scheduled_at
          ? new Date(row.slip_original_scheduled_at)
          : null,
        slipCount: row.slip_count,
        parentScheduledAt: parent.scheduledAt,
        parentComplete: parent.complete,
        window: cfg,
      });
      if (action.kind === "wait") {
        // Mark the child "engaged" on its first wait so a later parent-completion
        // is treated as regime a (slip to now+offset), not regime b (fire).
        if (action.engage) {
          await dbc.execute(sql`
            UPDATE campaign_stages
            SET slip_original_scheduled_at = COALESCE(slip_original_scheduled_at, ${action.originalScheduledAt.toISOString()})
            WHERE id = ${row.stage_id} AND sent_at IS NULL AND slip_hold_at IS NULL
          `);
        }
        result.slip_waiting++;
        continue;
      }
      if (action.kind === "slip") {
        // Re-date + preserve the original intent (COALESCE keeps it stable if it
        // was somehow already set). slip_count is observability.
        await dbc.execute(sql`
          UPDATE campaign_stages
          SET scheduled_at = ${action.newScheduledAt.toISOString()},
              slip_original_scheduled_at = COALESCE(slip_original_scheduled_at, ${action.originalScheduledAt.toISOString()}),
              slip_count = slip_count + 1
          WHERE id = ${row.stage_id} AND sent_at IS NULL AND slip_hold_at IS NULL
        `);
        result.slip_slipped++;
        await notifySlip(dbc, row, action.newScheduledAt);
        continue;
      }
      if (action.kind === "hold") {
        await dbc.execute(sql`
          UPDATE campaign_stages
          SET slip_hold_at = ${nowIso},
              slip_hold_reason = ${action.reason},
              slip_original_scheduled_at = COALESCE(slip_original_scheduled_at, ${action.originalScheduledAt.toISOString()})
          WHERE id = ${row.stage_id} AND sent_at IS NULL AND slip_hold_at IS NULL
        `);
        result.slip_held++;
        await notifyHold(dbc, row, action.reason, action.originalScheduledAt);
        continue;
      }
      // action.kind === "fire": parent is complete — fall through and let the
      // normal window decision run against the child's (placed) scheduled_at.
    }

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
  // Stages are grouped by their send-from PHONE. Groups drain CONCURRENTLY, so a
  // slow phone (a 3/s toll-free) never blocks a fast one (a 60/s short code) on a
  // different number — the head-of-line collapse of 2026-07-24. WITHIN a group
  // the stages ALSO drain concurrently (≤ STAGE_CONCURRENCY_PER_PHONE) sharing a
  // single per-phone TOKEN BUCKET, so the number's carrier rate is enforced by
  // the bucket rather than by serializing stages — the fix for same-phone
  // starvation (a stage held to 3.02 msg/s by its siblings' turn-taking). The
  // per-provider per-tick budget stays a shared, atomic reservation so concurrent
  // same-provider groups can't overshoot it. Each group runs under a PER-PHONE
  // `cron_locks` lease so an OVERLAPPING invocation (an overrun tick meeting the
  // next one) can never put two drain loops on the same NUMBER — see
  // PHONE_DRAIN_LEASE_MS.
  const drainable = await selectDrainableStages(dbc, { now, orgId, maxStages });

  const budget = makeProviderBudget();
  const drainedStageIds = new Set<number>();
  const phaseDeadlinePassed = () => Date.now() - runStartedAt >= PHASE_B_DEADLINE_MS;

  // Drain ONE stage for one budget reservation. Mutates `result` + the shared
  // budget; returns true iff the drain soft-yielded with pending rows left (so
  // the caller should come back to it THIS tick). All per-stage gates (pause /
  // budget / window / sent_at stamp) are unchanged — only the surrounding
  // control flow and the pacer did.
  const drainStageSlice = async (
    row: DrainableRow,
    shared: { bucket: TokenBucket; seenPhones: Set<string>; sentSinceMemo: SentSinceMemo },
  ): Promise<boolean> => {
    if (row.provider_id != null && (await isProviderPaused(dbc, row.provider_id))) {
      result.paused_skipped++;
      return false;
    }

    // Per-provider per-tick budget gate. Reserve a bounded slice atomically,
    // sized as ~BUDGET_RESERVE_SECONDS of THIS phone's own sending; the unused
    // part is released after the drain so concurrent same-provider groups share
    // the cap instead of one grabbing it all.
    let budgetGranted = Number.POSITIVE_INFINITY;
    const providerId = row.provider_id;
    if (providerId != null) {
      const cap = resolvePacingCap(row.max_sends_per_run);
      budgetGranted = budget.reserve(providerId, cap, budgetReserveFor(shared.bucket.rate));
      if (budgetGranted <= 0) {
        result.budget_held++;
        return false;
      }
    }
    // Release the reservation on any pre-drain bail-out (window hold/missed) so it
    // isn't leaked away from other stages this tick.
    const releaseBudget = () => {
      if (providerId != null && Number.isFinite(budgetGranted)) budget.release(providerId, budgetGranted);
    };

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
      const decision = row.scheduled_at
        ? decideScheduledSend(cfg, new Date(row.scheduled_at), now)
        : "fire";
      if (decision === "hold") {
        result.drain_held++;
        releaseBudget();
        return false;
      }
      if (decision === "missed") {
        await dbc.execute(sql`
          UPDATE campaign_stages SET schedule_missed_at = ${nowIso}
          WHERE id = ${row.stage_id} AND sent_at IS NULL AND schedule_missed_at IS NULL
        `);
        result.missed++;
        releaseBudget();
        return false;
      }
      // decision === "fire": fall through to the drain.
    } else if (isOutsideSendWindow(cfg, now)) {
      result.drain_held++;
      releaseBudget();
      return false;
    }

    // Wall-clock left in the phase. No per-stage sub-slice any more: same-phone
    // stages now run CONCURRENTLY under one token bucket, so a long-running stage
    // no longer blocks a sibling and doesn't need to be interrupted for it. The
    // drain checks this at SLICE boundaries and hands any claimed-but-undispatched
    // rows back to 'pending' before it yields.
    const stageMaxDurationMs = PHASE_B_DEADLINE_MS - (Date.now() - runStartedAt);
    const drain = await runDrain(row.stage_id, budgetGranted, stageMaxDurationMs, shared);
    drainedStageIds.add(row.stage_id);
    result.sent += drain.sent;
    result.failed += drain.failed;
    result.skipped_duplicate += drain.skippedDuplicate;
    result.skipped_opted_out += drain.skippedOptedOut;
    if (drain.pausedNow) result.paused_now++;
    // Return the unused reservation (processed ≤ granted) to the provider budget.
    if (providerId != null && Number.isFinite(budgetGranted)) {
      budget.release(providerId, budgetGranted - drain.processed);
    }

    // Bug 1 fix — INTEGRITY: stamp the release marker (sent_at) IF AND ONLY IF the
    // drain actually attempted ≥1 send (processed > 0). A gate-refused drain
    // returns processed 0 and leaves sent_at NULL, so the stage stays armed +
    // re-selectable — never a false "Sent".
    if (firstFire && drain.processed > 0) {
      await dbc.execute(sql`
        UPDATE campaign_stages SET sent_at = ${nowIso}
        WHERE id = ${row.stage_id} AND sent_at IS NULL
      `);
      row.sent_at = nowIso; // subsequent rounds treat it as a continuation
    }

    // Revisit this tick only if the drain SOFT-yielded (time-box/pacing) with rows
    // still pending — never after a gate refusal (ok=false) or a hard stop
    // (halted: pause / breaker), which must not be retried until a human acts.
    return drain.ok && !drain.halted && drain.remaining > 0;
  };

  // One phone's stages. They drain CONCURRENTLY (bounded by
  // STAGE_CONCURRENCY_PER_PHONE) sharing ONE token bucket, so the number's
  // carrier rate is enforced by the bucket rather than by serializing stages —
  // this is what fixes the same-phone starvation (a stage held to 3.02 msg/s by
  // its siblings' 20s round-robin turns). Each worker keeps re-draining its stage
  // until it has no pending rows left, it hard-stops, or the phase deadline hits.
  //
  // The whole group runs under a PER-PHONE lease so a still-running (overrun)
  // invocation's drain of this number is never doubled by the next tick. A phone
  // whose lease is held is SKIPPED CLEANLY: its rows stay 'pending', nothing is
  // marked missed, no error escapes, and the next tick picks it up.
  const drainPhoneGroup = async (stages: DrainableRow[]): Promise<void> => {
    const leaseKey = phoneDrainLeaseKey(stages[0].provider_phone_id, stages[0].stage_id);
    const leased = await withKeyedLease(dbc, leaseKey, PHONE_DRAIN_LEASE_MS, async () => {
      const shared = {
        bucket: makeTokenBucket(resolveSendsPerSecond(stages[0].max_sends_per_second)),
        seenPhones,
        sentSinceMemo,
      };
      await mapWithConcurrency(stages, STAGE_CONCURRENCY_PER_PHONE, async (row) => {
        while (!phaseDeadlinePassed()) {
          if (!(await drainStageSlice(row, shared))) break;
        }
      });
    });
    if (!leased.ran) result.phone_lease_skipped++;
  };

  // Partition by send-from phone; null-phone stages each form a singleton group.
  const groups = new Map<string, DrainableRow[]>();
  for (const row of drainable) {
    const key = phoneDrainLeaseKey(row.provider_phone_id, row.stage_id);
    const g = groups.get(key);
    if (g) g.push(row);
    else groups.set(key, [row]);
  }
  await mapWithConcurrency([...groups.values()], GROUP_CONCURRENCY, drainPhoneGroup);
  result.drained = drainedStageIds.size;

  return result;
}
