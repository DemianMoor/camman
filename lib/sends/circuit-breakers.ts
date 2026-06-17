import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

// Circuit-breaker tunables + decision helpers for the send drain. The PURE
// functions (resolve*/should*/ceilingBreached) are what the unit tests exercise;
// the DB helpers (isProviderPaused/countSentSince/latchPause) touch sms_providers
// + stage_sends + send_circuit_events.

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// SOFT per-invocation pacing cap default (rows sent per drain invocation). A
// 100k+ legit audience drains this many per */5 tick across many ticks — never
// pausing. Throughput within a tick comes from DEFAULT_SEND_CONCURRENCY (sends
// fire N-at-a-time), not from a bigger cap — the cap is a pacing bound, not the
// limiter it once was when the drain sent serially.
export const DEFAULT_MAX_SENDS_PER_RUN = 1000;
// Hard ceiling applied in code regardless of the provider column — so a
// misconfigured huge max_sends_per_run can never DEFEAT pacing. Also the
// structural tripwire bound: processing past this is impossible under correct
// code and latches a pause if it ever happens.
export const ABSOLUTE_MAX_SENDS_PER_RUN = 2000;
export const DEFAULT_MAX_SENDS_PER_MINUTE = 100;
export const DEFAULT_MAX_SENDS_PER_24H = 10000;
// Consecutive send failures in ONE invocation that latch the provider pause
// (broken creds/provider — stop wasting calls + flag for a human).
export const FAILURE_SPIKE_THRESHOLD = 10;
// How many recipient sends the drain fires CONCURRENTLY within a claimed batch.
// The drain used to await each TextHub round-trip serially (~2 sends/sec), so a
// run hit the 300s function timeout at ~600 sends regardless of the pacing cap.
// Sending N at a time lifts throughput ~N×. Kept conservative (TextHub's
// documented per-key rate limit is not yet confirmed); raise once it is. The
// per-minute / 24h ceilings remain the policy-rate backstops above this.
export const DEFAULT_SEND_CONCURRENCY = 10;

// Why a drain invocation stopped before draining the stage. Hard stops latch a
// pause (human must resume); soft stops just leave rows pending for next tick.
export type DrainStopReason =
  | "paused" // provider is/became send_paused (latched) — HARD
  | "failure_spike" // consecutive failures latched a pause — HARD
  | "pacing_tripwire" // processed exceeded the clamped cap (impossible) — HARD
  | "rate_minute" // per-minute ceiling — SOFT, retry next tick
  | "rate_24h" // 24h ceiling — SOFT, retry next tick
  | "org_disabled"; // DB master switch flipped off mid-run — SOFT, retry next tick

export function isHardStop(reason: DrainStopReason): boolean {
  return reason === "paused" || reason === "failure_spike" || reason === "pacing_tripwire";
}

// Resolve + CLAMP the per-invocation pacing cap. NULL ⇒ default; any value is
// clamped to [1, ABSOLUTE_MAX] so the column can tune DOWN freely but can never
// remove pacing or exceed the absolute ceiling.
export function resolvePacingCap(configured: number | null | undefined): number {
  const v = configured == null ? DEFAULT_MAX_SENDS_PER_RUN : configured;
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(Math.floor(v), ABSOLUTE_MAX_SENDS_PER_RUN);
}

export function resolveMinuteCap(configured: number | null | undefined): number {
  const v = configured == null ? DEFAULT_MAX_SENDS_PER_MINUTE : configured;
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_MAX_SENDS_PER_MINUTE;
}

export function resolve24hCap(configured: number | null | undefined): number {
  const v = configured == null ? DEFAULT_MAX_SENDS_PER_24H : configured;
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_MAX_SENDS_PER_24H;
}

export function shouldTripFailureSpike(consecutiveFailures: number): boolean {
  return consecutiveFailures >= FAILURE_SPIKE_THRESHOLD;
}

// A soft rolling ceiling is breached when the already-sent count in the window
// is at or above the cap (checked BEFORE claiming the next batch). Since the
// drain stamps sent_at as it goes, in-invocation sends count toward the window —
// so the rate self-throttles within a single run.
export function ceilingBreached(countInWindow: number, cap: number): boolean {
  return countInWindow >= cap;
}

// ── DB helpers ──────────────────────────────────────────────────────────────

// Re-read the latching pause fresh (not from the cached ctx) so a concurrent
// trip — auto or manual panic — kills an IN-FLIGHT drain at the next batch. This
// is the true mid-invocation kill the env SEND_ENABLED flag can't deliver.
export async function isProviderPaused(dbc: DbOrTx, providerId: number): Promise<boolean> {
  const r = (await dbc.execute(sql`
    SELECT send_paused FROM sms_providers WHERE id = ${providerId} LIMIT 1
  `)) as unknown as { send_paused: boolean }[];
  return r[0]?.send_paused === true;
}

// Org-wide successful-send count within the trailing window (seconds). Counts
// sent_at (real send time) only — failed attempts have no sent_at, so this
// measures emitted-message rate, not API-call rate. SCOPE LIMITATION: org-wide
// as a proxy for the provider until provider #2 (see migration 0058).
export async function countSentSince(
  dbc: DbOrTx,
  orgId: string,
  seconds: number,
): Promise<number> {
  const r = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM stage_sends
    WHERE org_id = ${orgId}
      AND sent_at IS NOT NULL
      AND sent_at > now() - make_interval(secs => ${seconds})
  `)) as unknown as { n: number }[];
  return Number(r[0]?.n ?? 0);
}

// Latch the provider pause + append an audit event. Idempotent: only the FIRST
// trip stamps reason/at and logs (the WHERE send_paused = false guard), so a
// re-trip on an already-paused provider is a no-op. actorUserId NULL ⇒ a system
// auto-trip; the manual panic/resume path passes the session user.
export async function latchPause(
  dbc: DbOrTx,
  opts: { providerId: number; orgId: string; reason: string; actorUserId?: string | null },
): Promise<boolean> {
  const updated = (await dbc.execute(sql`
    UPDATE sms_providers
    SET send_paused = true,
        send_paused_reason = ${opts.reason},
        send_paused_at = now()
    WHERE id = ${opts.providerId} AND send_paused = false
    RETURNING id
  `)) as unknown as { id: number }[];
  if (updated.length === 0) return false; // already paused — don't double-log
  await dbc.execute(sql`
    INSERT INTO send_circuit_events (org_id, provider_id, event, reason, actor_user_id)
    VALUES (${opts.orgId}, ${opts.providerId}, 'paused', ${opts.reason}, ${opts.actorUserId ?? null})
  `);
  return true;
}
