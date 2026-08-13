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
  | "org_paused" // emergency hard-stop engaged mid-run — SOFT, resumes on Proceed
  // Provider send window (quiet hours) closed. SOFT by design: the rows stay
  // pending and the next tick INSIDE the window resumes them. Nothing failed —
  // we simply must not be sending at this hour.
  | "outside_send_window";

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

// Successful-send count for ONE provider within the trailing window (seconds).
// Counts sent_at (real send time) only — failed attempts have no sent_at, so
// this measures emitted-message rate, not API-call rate. Scoped to the stage's
// provider so one provider's volume can't trip another's ceiling: stage_sends
// carries no provider_id, so the provider is reached via
// stage_sends.stage_id -> campaign_stages.sms_provider_id. The org_id filter
// stays (multi-tenancy invariant). Plan at prod scale: index scan on stage_sends
// by the sent_at window + hash join the tiny per-provider campaign_stages set
// (~64ms for a 24h window over ~52k rows; existing indexes suffice).
export async function countSentSince(
  dbc: DbOrTx,
  orgId: string,
  providerId: number,
  seconds: number,
): Promise<number> {
  const r = (await dbc.execute(sql`
    SELECT count(*)::int AS n
    FROM stage_sends ss
    JOIN campaign_stages s ON s.id = ss.stage_id
    WHERE ss.org_id = ${orgId}
      AND s.sms_provider_id = ${providerId}
      AND ss.sent_at IS NOT NULL
      AND ss.sent_at > now() - make_interval(secs => ${seconds})
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

// ── P7/P8: rolling opt-out-rate breaker (per-STAGE metric, per-CAMPAIGN latch) ─
// A high STOP rate is a content/audience signal, not a provider-transport fault,
// so this breaker pauses ONE campaign (campaigns.send_paused) rather than the
// whole provider. Env-tunable like the Ahoi DLR breaker — read through helpers so
// a redeploy isn't needed to change sensitivity.
//
// THE METRIC IS AN ALIGNED PER-STAGE SEND COHORT: "of the messages this stage
// sent in the trailing window, what fraction has produced a STOP so far".
// Numerator and denominator describe the SAME messages — both are bucketed by
// stage_sends.sent_at, never by the STOP's arrival time. Bucketing the numerator
// by receipt time is what produced the 2026-07-25 false trips (a blast's STOPs
// outlived the blast's own messages in the window and were divided by whatever
// small volume happened to be left). See
// docs/optout-rate-breaker-false-trip-2026-07-25.md.
//
// CALIBRATION (re-derived 2026-07-26 on the aligned per-stage cohort, live data,
// 318 stages with >= 200 sends):
//   24h cohort — p95 7.19%, p99 8.03%, max 8.41%  ⇒ threshold 10%
//    2h cohort — p95 5.23%, p99 5.92%, max 6.12%  ⇒ threshold  8%
// Each threshold sits above the observed maximum, so a healthy stage cannot trip.
// (The figures the previous comment cited — "330 stages >=50 sends: p95 7.4%,
// p99 8.4%, max 13.8%" — were per-stage LIFETIME aligned rates, i.e. already a
// different metric from the receipt-time one the runtime then evaluated. That
// mismatch is the bug this calibration note now closes.)
//
// TWO WINDOWS, one metric. The long (24h) window is the primary judgement; the
// short (2h) twin exists because a cohort rate necessarily under-reads right
// after a blast (the STOPs haven't arrived yet), which would make a genuinely
// toxic creative slow to catch. The short window is a strict SUBSET of the long
// one, so both are computed in ONE pass per side with FILTER — the per-STOP
// query count stays at 2.
export function optOutRateSpikeThreshold(): number {
  const v = Number(process.env.OPTOUT_RATE_SPIKE_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.1; // 10%
}
export function optOutRateMinSends(): number {
  const v = Number(process.env.OPTOUT_RATE_MIN_SENDS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 200;
}
export function optOutRateWindowSeconds(): number {
  const v = Number(process.env.OPTOUT_RATE_WINDOW_SEC);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 24 * 60 * 60; // 24h trailing
}
export function optOutRateSpikeThresholdShort(): number {
  const v = Number(process.env.OPTOUT_RATE_SPIKE_THRESHOLD_SHORT);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.08; // 8%
}
export function optOutRateMinSendsShort(): number {
  const v = Number(process.env.OPTOUT_RATE_MIN_SENDS_SHORT);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 200;
}
export function optOutRateShortWindowSeconds(): number {
  const v = Number(process.env.OPTOUT_RATE_WINDOW_SHORT_SEC);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 2 * 60 * 60; // 2h trailing
}

/** Counts for the long window and its short subset, from one query. */
export interface WindowPairCounts {
  long: number;
  short: number;
}

// Denominator: this STAGE's successful sends, bucketed by sent_at, for both
// windows at once. Served by stage_sends_stage_id_idx.
export async function countSentInWindowsForStage(
  dbc: DbOrTx,
  orgId: string,
  stageId: number,
  longSeconds: number,
  shortSeconds: number,
): Promise<WindowPairCounts> {
  const r = (await dbc.execute(sql`
    SELECT count(*) FILTER (WHERE sent_at > now() - make_interval(secs => ${longSeconds}))::int  AS n_long,
           count(*) FILTER (WHERE sent_at > now() - make_interval(secs => ${shortSeconds}))::int AS n_short
    FROM stage_sends
    WHERE org_id = ${orgId} AND stage_id = ${stageId} AND status = 'sent'
      AND sent_at > now() - make_interval(secs => ${longSeconds})
  `)) as unknown as { n_long: number; n_short: number }[];
  return { long: Number(r[0]?.n_long ?? 0), short: Number(r[0]?.n_short ?? 0) };
}

// Numerator: STOPs attributed to this STAGE, bucketed by the ORIGINATING SEND's
// sent_at — the same messages the denominator counts. opt_out_attributions is
// already de-duped one-per-STOP-per-stage, so a multi-message sequence can't
// inflate the rate.
//
// Rows with a NULL stage_send_id are EXCLUDED (the inner join drops them). There
// is deliberately NO fallback to oa.stage_id + oa.created_at: that would
// reintroduce receipt-time bucketing for exactly the rows we can't align, which
// is the defect. The blind spot is watched instead by the hourly
// findUnjoinableOptOutAttributions check (lib/sends/unjoinable-attributions.ts).
//
// Scoped by oa.stage_id (opt_out_attributions_stage_id_idx) and joined to
// stage_sends by primary key — a few hundred rows at most per stage. The
// ingesters always write oa.stage_id = the matched send's stage_id, so scoping on
// either column selects the same set; oa.stage_id is the indexed one.
// `status = 'sent'` keeps the numerator a strict subset of the denominator's
// population, so the rate can never exceed 1.
export async function countAlignedOptOutsInWindowsForStage(
  dbc: DbOrTx,
  orgId: string,
  stageId: number,
  longSeconds: number,
  shortSeconds: number,
): Promise<WindowPairCounts> {
  const r = (await dbc.execute(sql`
    SELECT count(*) FILTER (WHERE ss.sent_at > now() - make_interval(secs => ${longSeconds}))::int  AS n_long,
           count(*) FILTER (WHERE ss.sent_at > now() - make_interval(secs => ${shortSeconds}))::int AS n_short
    FROM opt_out_attributions oa
    JOIN stage_sends ss ON ss.id = oa.stage_send_id
    WHERE oa.org_id = ${orgId} AND oa.stage_id = ${stageId} AND ss.status = 'sent'
      AND ss.sent_at > now() - make_interval(secs => ${longSeconds})
  `)) as unknown as { n_long: number; n_short: number }[];
  return { long: Number(r[0]?.n_long ?? 0), short: Number(r[0]?.n_short ?? 0) };
}

// Fresh read of the per-campaign latch (mirror of isProviderPaused) for the
// drain's mid-invocation kill.
export async function isCampaignPaused(dbc: DbOrTx, campaignId: number): Promise<boolean> {
  const r = (await dbc.execute(sql`
    SELECT send_paused FROM campaigns WHERE id = ${campaignId} LIMIT 1
  `)) as unknown as { send_paused: boolean }[];
  return r[0]?.send_paused === true;
}

// Latch the per-campaign pause + append a campaign_circuit_events audit row.
// Idempotent (WHERE send_paused = false), so a re-trip is a no-op. Mirrors
// latchPause exactly, on the campaign row + its own audit table. actorUserId
// NULL ⇒ system auto-trip (the opt-out-rate breaker); a session user on manual.
export async function latchCampaignPause(
  dbc: DbOrTx,
  opts: { campaignId: number; orgId: string; reason: string; actorUserId?: string | null },
): Promise<boolean> {
  const updated = (await dbc.execute(sql`
    UPDATE campaigns
    SET send_paused = true,
        send_paused_reason = ${opts.reason},
        send_paused_at = now()
    WHERE id = ${opts.campaignId} AND send_paused = false
    RETURNING id
  `)) as unknown as { id: number }[];
  if (updated.length === 0) return false; // already paused — don't double-log
  await dbc.execute(sql`
    INSERT INTO campaign_circuit_events (org_id, campaign_id, event, reason, actor_user_id)
    VALUES (${opts.orgId}, ${opts.campaignId}, 'paused', ${opts.reason}, ${opts.actorUserId ?? null})
  `);
  return true;
}
