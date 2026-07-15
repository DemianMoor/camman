import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

// Circuit-breaker tunables + decision helpers for the send drain. The PURE
// functions (resolve*/should*/ceilingBreached) are what the unit tests exercise;
// the DB helpers (isProviderPaused/countSentSince/latchPause) touch sms_providers
// + stage_sends + send_circuit_events.

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// SOFT per-invocation pacing cap default (rows sent per drain invocation). A
// 100k+ legit audience drains this many per */5 tick across many ticks — never
// pausing. Throughput within a tick comes from the per-second send rate (sends
// fire in paced parallel slices), not from a bigger cap.
export const DEFAULT_MAX_SENDS_PER_RUN = 1000;
// Hard ceiling applied in code regardless of the provider column — so a
// misconfigured huge max_sends_per_run can never DEFEAT pacing. Also the
// structural tripwire bound: processing past this is impossible under correct
// code and latches a pause if it ever happens. Raised 2000→20000 once the drain
// gained parallel+batched sends: at 60/s a single 300s invocation can complete
// ~18k, so 2000 had become an artificial per-tick throttle. The per-second rate
// and the 300s function budget are the real anti-runaway guards now.
export const ABSOLUTE_MAX_SENDS_PER_RUN = 20000;
export const DEFAULT_MAX_SENDS_PER_MINUTE = 100;
export const DEFAULT_MAX_SENDS_PER_24H = 10000;
// Consecutive send failures in ONE invocation that latch the provider pause
// (broken creds/provider — stop wasting calls + flag for a human).
export const FAILURE_SPIKE_THRESHOLD = 10;
// HARD per-second send rate the drain paces to: it fires up to this many sends
// in parallel, then waits out the rest of the second before the next slice. This
// is the INSTANTANEOUS ceiling that respects the provider's documented limit —
// e.g. TextHub allows 60/s on a short code, 3/s on a toll-free number. NULL on
// the provider ⇒ this conservative default. The per-minute / 24h ceilings remain
// the rolling VOLUME backstops above it (60/s = 3600/min, so a low
// max_sends_per_minute will still throttle sustained volume).
export const DEFAULT_SENDS_PER_SECOND = 10;
// Sanity bound on the per-second rate so a typo can't make the drain open
// thousands of simultaneous connections. Above any real provider limit.
export const ABSOLUTE_MAX_SENDS_PER_SECOND = 1000;

// Why a drain invocation stopped before draining the stage. Hard stops latch a
// pause (human must resume); soft stops just leave rows pending for next tick.
export type DrainStopReason =
  | "paused" // provider is/became send_paused (latched) — HARD
  | "failure_spike" // consecutive failures latched a pause — HARD
  | "pacing_tripwire" // processed exceeded the clamped cap (impossible) — HARD
  | "rate_minute" // per-minute ceiling — SOFT, retry next tick
  | "rate_24h" // 24h ceiling — SOFT, retry next tick
  | "org_disabled" // DB master switch flipped off mid-run — SOFT, retry next tick
  | "org_paused"; // emergency hard-stop engaged mid-run — SOFT, resumes on Proceed

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

// Resolve + CLAMP the per-second send rate. NULL ⇒ default; clamped to
// [1, ABSOLUTE_MAX] so it can never be 0 (which would stall the drain) nor open
// an unbounded number of simultaneous connections.
export function resolveSendsPerSecond(configured: number | null | undefined): number {
  const v = configured == null ? DEFAULT_SENDS_PER_SECOND : configured;
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(Math.floor(v), ABSOLUTE_MAX_SENDS_PER_SECOND);
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

// Ahoi DLR-driven reject-rate signal (Section 3, spec §5 derived signal (a)).
// Distinct from FAILURE_SPIKE_THRESHOLD above (consecutive SEND-time failures
// within one drain invocation): a DLR can report `rejected` for a send that
// looked fine at send time (Ahoi's always-200 body said {status:"ok"}), so
// this is a genuinely different, asynchronous, carrier-level signal that only
// arrives minutes later. Provider-scoped (not the org-wide proxy the
// send-time breaker uses) since ahoi_dlr_events already carries a real
// provider_id per row — no "until provider #2" caveat applies here.
//
// DEFENSIVE (G4/O1): `rejected` is doc-inferred, never observed live in Phase
// 0 recon (only carrier_sent/delivered with error=000 were seen). This
// threshold exists so that WHEN it does start appearing, a spike trips a
// pause instead of silently burning through a broken number/route.
//
// CONFIG, not hardcoded: threshold + window are env-tunable so ops can adjust
// sensitivity without a code change (the whole signal is provisional until a
// real reject rate is observed). Defaults are identical to the original
// constants (10 rejects / 900s). Read through helpers, not module-load
// constants, so a redeploy isn't needed to pick up a changed env value.
export function ahoiDlrRejectSpikeThreshold(): number {
  const v = Number(process.env.AHOI_DLR_REJECT_SPIKE_THRESHOLD);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 10;
}
export function ahoiDlrRejectWindowSeconds(): number {
  const v = Number(process.env.AHOI_DLR_REJECT_SPIKE_WINDOW_SEC);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 900;
}

export async function countAhoiDlrRejectsSince(
  dbc: DbOrTx,
  providerId: number,
  seconds: number,
): Promise<number> {
  const r = (await dbc.execute(sql`
    SELECT count(*)::int AS n FROM ahoi_dlr_events
    WHERE provider_id = ${providerId}
      AND send_status = 'rejected'
      AND received_at > now() - make_interval(secs => ${seconds})
  `)) as unknown as { n: number }[];
  return Number(r[0]?.n ?? 0);
}
