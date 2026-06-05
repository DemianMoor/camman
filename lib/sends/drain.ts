import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { can, type Role } from "@/lib/permissions";
import {
  ceilingBreached,
  countSentSince,
  type DrainStopReason,
  isProviderPaused,
  latchPause,
  resolve24hCap,
  resolveMinuteCap,
  resolvePacingCap,
  shouldTripFailureSpike,
} from "@/lib/sends/circuit-breakers";
import { resolveProviderApiKey } from "@/lib/sends/provider-credential";
import { sendSms as realSendSms, type SendSmsResult } from "@/lib/sends/texthub";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Dual-auth decision for the drain endpoint, kept PURE so the "no gap between
// the two paths" guarantee is testable. Either a matching CRON_SECRET Bearer
// (programmatic/cron) OR an authenticated session with manager+ (campaigns.drain)
// is accepted; anything else is rejected. A request with NEITHER a valid Bearer
// NOR a session must reject (401), and an authenticated-but-under-privileged
// session must reject (403) — never fall through to allow.
export type DrainAuthDecision =
  | { allow: true; via: "cron" | "session" }
  | { allow: false; status: 401 | 403 };

export function decideDrainAuth(opts: {
  bearerMatches: boolean;
  sessionRole: Role | null;
}): DrainAuthDecision {
  if (opts.bearerMatches) return { allow: true, via: "cron" };
  if (!opts.sessionRole) return { allow: false, status: 401 };
  if (!can(opts.sessionRole, "campaigns.drain")) return { allow: false, status: 403 };
  return { allow: true, via: "session" };
}

// Injectable so verify-drain can supply a deterministic fake instead of hitting
// TextHub. Default = the real client.
export type Sender = (opts: {
  apiKey: string;
  text: string;
  number: string;
  leadId?: string | null;
}) => Promise<SendSmsResult>;

export type DrainRefusal =
  | "not_found"
  | "not_approved"
  | "send_disabled"
  | "provider_paused" // the latching circuit breaker is engaged for this provider
  | "no_provider"
  | "no_credentials";

export interface DrainResult {
  ok: boolean;
  reason?: DrainRefusal;
  sent: number;
  failed: number;
  processed: number;
  halted: boolean; // stopped early (kill-switch off, pause, or a breaker trip)
  stuck: number; // rows left in 'sending' (crashed mid-send — manual review)
  remaining: number; // rows still 'pending'
  // Why an in-flight drain stopped before draining the stage (null = ran to
  // natural completion or hit the soft pacing cap with rows still pending).
  stopReason?: DrainStopReason | null;
  // True when THIS invocation latched the provider pause (hard stop). A human
  // must consciously resume via the provider UI.
  pausedNow?: boolean;
}

// The SEND_ENABLED kill-switch. NOTE: this is an env var, which is fixed for
// the life of a serverless invocation — re-reading it between batches gives a
// fresh read each batch, but a flip only takes effect on the NEXT invocation,
// not truly mid-invocation. A within-invocation kill would require a
// runtime-mutable (DB-backed) flag — see the flagged conflict.
function envSendEnabled(): boolean {
  return process.env.SEND_ENABLED === "true";
}

const EMPTY = {
  sent: 0,
  failed: 0,
  processed: 0,
  halted: false,
  stuck: 0,
  remaining: 0,
  stopReason: null,
  pausedNow: false,
};

interface ClaimedRow {
  id: string;
  phone: string;
  rendered_text: string;
  lead_id: string | null;
}

// Drain one stage's pending sends. Gates: send_approved (per-stage) + the
// SEND_ENABLED kill-switch (re-checked between batches). Claims a batch with
// FOR UPDATE SKIP LOCKED → 'sending' (durable before the HTTP call), sends via
// TextHub, then marks 'sent' (+texthub_message_id, sent_at) or 'failed'
// (+last_error); attempts++ either way. At-most-once: only 'pending' rows are
// ever claimed, so a row stuck in 'sending' (process died mid-send) is NEVER
// auto-retried — it's surfaced in `stuck` for manual review.
export async function runStageDrain(
  dbc: DbOrTx,
  opts: {
    stageId: number;
    sendSms?: Sender;
    isEnabled?: () => boolean;
    batchSize?: number;
    maxRows?: number;
  },
): Promise<DrainResult> {
  const sendSms = opts.sendSms ?? realSendSms;
  const isEnabled = opts.isEnabled ?? envSendEnabled;
  const batchSize = opts.batchSize ?? 50;

  const ctx = (await dbc.execute(sql`
    SELECT s.sms_provider_id AS provider_id,
           s.send_approved    AS send_approved,
           c.org_id           AS org_id,
           c.brand_id         AS brand_id,
           p.send_paused          AS send_paused,
           p.max_sends_per_run    AS max_sends_per_run,
           p.max_sends_per_minute AS max_sends_per_minute,
           p.max_sends_per_24h    AS max_sends_per_24h
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    WHERE s.id = ${opts.stageId}
    LIMIT 1
  `)) as unknown as {
    provider_id: number | null;
    send_approved: boolean;
    org_id: string;
    brand_id: number | null;
    send_paused: boolean | null;
    max_sends_per_run: number | null;
    max_sends_per_minute: number | null;
    max_sends_per_24h: number | null;
  }[];

  const stage = ctx[0];
  if (!stage) return { ok: false, reason: "not_found", ...EMPTY };
  if (!stage.send_approved) return { ok: false, reason: "not_approved", ...EMPTY };
  if (!isEnabled()) return { ok: false, reason: "send_disabled", ...EMPTY };
  // Latching circuit breaker: refuse before claiming anything. A human must
  // resume via the provider UI; nothing here clears it.
  if (stage.send_paused) return { ok: false, reason: "provider_paused", ...EMPTY };
  if (stage.provider_id == null) return { ok: false, reason: "no_provider", ...EMPTY };

  const apiKey = await resolveProviderApiKey(dbc, {
    orgId: stage.org_id,
    providerId: stage.provider_id,
    brandId: stage.brand_id,
  });
  if (!apiKey) return { ok: false, reason: "no_credentials", ...EMPTY };

  const providerId = stage.provider_id;
  const orgId = stage.org_id;
  // SOFT per-invocation pacing cap (clamped) drives the loop bound. opts.maxRows
  // still wins when injected (tests). Reaching it leaves rows pending for the
  // next tick — NOT a pause.
  const pacingCap = resolvePacingCap(stage.max_sends_per_run);
  const effectiveMaxRows = opts.maxRows ?? pacingCap;
  const minuteCap = resolveMinuteCap(stage.max_sends_per_minute);
  const cap24h = resolve24hCap(stage.max_sends_per_24h);

  let sent = 0;
  let failed = 0;
  let processed = 0;
  let halted = false;
  let stopReason: DrainStopReason | null = null;
  let pausedNow = false;
  let consecutiveFailures = 0;

  while (processed < effectiveMaxRows) {
    // Re-check the kill-switch BEFORE each batch so flipping it off stops the
    // drain (subject to the env-immutability caveat above).
    if (!isEnabled()) {
      halted = true;
      break;
    }

    // True mid-run kill: a concurrent pause (auto-trip or manual panic) halts
    // the in-flight drain at the next batch boundary, before any new claim.
    if (await isProviderPaused(dbc, providerId)) {
      halted = true;
      stopReason = "paused";
      break;
    }

    // SOFT rolling ceilings — stop the run (leave rows pending), do NOT pause.
    // Counted org-wide incl. this run's own sends, so the rate self-throttles.
    if (ceilingBreached(await countSentSince(dbc, orgId, 60), minuteCap)) {
      stopReason = "rate_minute";
      break;
    }
    if (ceilingBreached(await countSentSince(dbc, orgId, 86_400), cap24h)) {
      stopReason = "rate_24h";
      break;
    }

    const limit = Math.min(batchSize, effectiveMaxRows - processed);
    const claimed = (await dbc.execute(sql`
      UPDATE stage_sends SET status = 'sending'
      WHERE id IN (
        SELECT id FROM stage_sends
        WHERE stage_id = ${opts.stageId} AND status = 'pending'
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING id, phone, rendered_text, lead_id
    `)) as unknown as ClaimedRow[];

    if (claimed.length === 0) break;

    for (const c of claimed) {
      const res = await sendSms({
        apiKey,
        text: c.rendered_text,
        number: c.phone,
        leadId: c.lead_id,
      });
      if (res.ok) {
        await dbc.execute(sql`
          UPDATE stage_sends
          SET status = 'sent', texthub_message_id = ${res.messageId},
              sent_at = now(), attempts = attempts + 1
          WHERE id = ${c.id}
        `);
        sent++;
        consecutiveFailures = 0;
      } else {
        await dbc.execute(sql`
          UPDATE stage_sends
          SET status = 'failed', last_error = ${res.error}, attempts = attempts + 1
          WHERE id = ${c.id}
        `);
        failed++;
        consecutiveFailures++;
      }
      processed++;

      // Failure spike → latch the pause (creds/provider likely broken; stop
      // wasting calls). Already-sent rows in this batch stand; the rest of the
      // claimed batch is abandoned to 'sending' (surfaced as stuck for review).
      if (shouldTripFailureSpike(consecutiveFailures)) {
        pausedNow = await latchPause(dbc, {
          providerId,
          orgId,
          reason: `failure_spike: ${consecutiveFailures} consecutive send failures`,
        });
        halted = true;
        stopReason = "failure_spike";
        break;
      }
    }
    if (stopReason) break;
  }

  // Structural tripwire: under correct code `processed` can never exceed the
  // clamped cap (limit math lands exactly on it). If it ever does, a loop bug is
  // live — latch the pause and flag.
  if (processed > Math.max(effectiveMaxRows, pacingCap)) {
    pausedNow =
      (await latchPause(dbc, {
        providerId,
        orgId,
        reason: `pacing_tripwire: processed ${processed} > cap ${effectiveMaxRows}`,
      })) || pausedNow;
    halted = true;
    stopReason = "pacing_tripwire";
  }

  const counts = (await dbc.execute(sql`
    SELECT
      count(*) FILTER (WHERE status = 'sending')::int AS stuck,
      count(*) FILTER (WHERE status = 'pending')::int AS remaining
    FROM stage_sends WHERE stage_id = ${opts.stageId}
  `)) as unknown as { stuck: number; remaining: number }[];

  const remaining = Number(counts[0]?.remaining ?? 0);
  const stuck = Number(counts[0]?.stuck ?? 0);

  // Tier-1 alert: only when THIS invocation auto-latched the pause (a breaker
  // trip, not a manual/concurrent pause). Best-effort; never throws or blocks.
  if (pausedNow) {
    await notifyTelegram(
      `🛑 Send circuit breaker TRIPPED\n` +
        `reason: ${stopReason}\n` +
        `provider: ${providerId} (org ${orgId})\n` +
        `stage: ${opts.stageId} · sent ${sent}, failed ${failed}, stuck ${stuck}, remaining ${remaining}\n` +
        `Sending is now PAUSED for this provider — resume manually after fixing the cause.`,
    );
  }

  return {
    ok: true,
    sent,
    failed,
    processed,
    halted,
    stuck,
    remaining,
    stopReason,
    pausedNow,
  };
}
