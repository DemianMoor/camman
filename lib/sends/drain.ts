import { sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { can, type Role } from "@/lib/permissions";
import {
  ATTEMPTS_INSERT_CHUNK,
  ceilingBreached,
  countSentSince,
  type DrainStopReason,
  isCampaignPaused,
  isProviderPaused,
  latchPause,
  resolve24hCap,
  resolveDrainBatchSize,
  resolveMinuteCap,
  resolvePacingCap,
  resolveSendsPerSecond,
  type SentSinceMemo,
  shouldTripFailureSpike,
} from "@/lib/sends/circuit-breakers";
import { classifyAttempt } from "@/lib/sends/classify-attempt";
import { SEND_DEDUP_WINDOW_MS } from "@/lib/sends/dedup-window";
import { getOrgSendsEnabled, getOrgSendsPaused } from "@/lib/sends/org-send-flag";
import { resolveKeyForStage } from "@/lib/sends/provider-credential";
import { getAdapter, UnknownProviderError } from "@/lib/sends/providers/registry";
import type { NormalizedSendParams } from "@/lib/sends/providers/types";
import { buildSendUrl, type SendSmsResult } from "@/lib/sends/texthub";
import { makeTokenBucket, type TokenBucket } from "@/lib/sends/token-bucket";

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
  // Stage's provider_phones.phone_number (E.164), for adapters that need a
  // sending number (Ahoi). OPTIONAL so existing injected test fakes
  // (scripts/verify-drain.ts) that don't destructure it keep compiling
  // unchanged. TextHub's adapter ignores it.
  senderNumber?: string | null;
}) => Promise<SendSmsResult>;

export type DrainRefusal =
  | "not_found"
  | "not_approved"
  | "send_disabled" // env SEND_ENABLED off (deploy-level backstop)
  | "send_disabled_org" // DB org_settings.sends_enabled off (daily operational switch)
  | "send_paused_org" // org_settings.sends_paused — the emergency hard-stop
  | "provider_paused" // the latching circuit breaker is engaged for this provider
  | "campaign_paused" // the per-campaign latch (opt-out-rate breaker / manual)
  | "no_provider"
  | "unknown_provider" // provider row's sms_provider_id has no registered adapter (G3)
  | "no_credentials";

export interface DrainResult {
  ok: boolean;
  reason?: DrainRefusal;
  sent: number;
  failed: number;
  // TextHub rejected the send with its structured {"status":"Suppressed"} token
  // (a number it blocks on its side). Counted separately from `failed` so the
  // operator can see provider-suppression vs genuine failures. LABEL ONLY — these
  // are NOT opted out and NOT skipped in future campaigns.
  filtered: number;
  // Rows NOT sent because the phone already received a message within the global
  // 1-hour dedup window (lib/sends/dedup-window.ts). Marked 'skipped_duplicate' —
  // terminal, not sent, not opted-out, not auto-retried.
  skippedDuplicate: number;
  // Rows NOT sent because the contact opted out (STOP) AFTER the stage was
  // materialized. The frozen stage_sends set is filtered for opt-outs only at
  // materialization; this is the send-time re-check that honors a STOP landing in
  // the materialize→dispatch window. Marked 'skipped_opted_out' — terminal, and
  // DISTINCT from provider rejects (failed/filtered) and manual aborts (rejected)
  // so stage stats can count STOP-cancels on their own.
  skippedOptedOut: number;
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

// Split an array into fixed-size chunks (used to bound the multi-row
// `send_attempts` INSERT — see ATTEMPTS_INSERT_CHUNK).
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// `send_attempts.latency_ms` ships in migration 0125, which CANNOT be applied
// until 0121–0124 (unmerged, another branch) land first. Rather than couple this
// code to a migration it can't control, the attempt INSERT omits the column when
// it isn't there yet: sending keeps working on either schema, and latency starts
// being recorded the moment the migration applies — no deploy ordering to get
// wrong, and no window where a send fails because a column is missing.
//
// Probed ONCE per process (serverless instances are short-lived, so a `false`
// memoized just before the migration lands is corrected within minutes by the
// next cold start) and never on the per-batch hot path.
let latencyColumnProbe: Promise<boolean> | null = null;
function hasLatencyColumn(dbc: DbOrTx): Promise<boolean> {
  latencyColumnProbe ??= dbc
    .execute(sql`
      SELECT 1 AS present FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'send_attempts'
        AND column_name = 'latency_ms'
      LIMIT 1
    `)
    .then((rows) => (rows as unknown as unknown[]).length > 0)
    .catch(() => false);
  return latencyColumnProbe;
}

// Test seam — lets a harness assert both schema shapes without a process restart.
export function __resetLatencyColumnProbe(): void {
  latencyColumnProbe = null;
}

// Resolve the send function for a stage's provider. Injected fake (verify-drain)
// wins for determinism; otherwise the registry adapter's bound send. Throws
// UnknownProviderError for an unregistered key — the caller maps it to the
// `unknown_provider` refusal (G3: never a raw throw out of the drain run).
export function resolveSenderForStage(providerKey: string, injected?: Sender): Sender {
  if (injected) return injected;
  const adapter = getAdapter(providerKey);
  return ({ apiKey, text, number, leadId, senderNumber }) =>
    adapter.send({ apiKey, text, recipientE164: number, senderNumber: senderNumber ?? null, leadId });
}

const EMPTY = {
  sent: 0,
  failed: 0,
  filtered: 0,
  skippedDuplicate: 0,
  skippedOptedOut: 0,
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
  contact_id: string;
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
    // DB master switch (org_settings.sends_enabled). Injectable for tests, same
    // as isEnabled; defaults to the real per-org read. Re-checked between batches
    // so flipping it off in Settings stops an in-flight drain at the next batch.
    isOrgEnabled?: (orgId: string) => Promise<boolean>;
    // Emergency hard-stop (org_settings.sends_paused). Injectable like isOrgEnabled;
    // defaults to the real per-org read. Re-checked between batches so engaging the
    // "Today's sends" hard-stop kills an in-flight drain at the next batch.
    isOrgPaused?: (orgId: string) => Promise<boolean>;
    batchSize?: number;
    maxRows?: number;
    // FAIRNESS TIME-BOX: max wall-clock this drain may spend before yielding.
    // Checked between batches (never mid-batch — at-most-once is preserved): once
    // exceeded, the drain stops claiming and returns with rows left 'pending', to
    // be resumed next tick — the SAME soft-stop semantics as reaching the pacing
    // cap. This is what stops a slow-phone stage (e.g. a 3/s number) from
    // monopolizing the whole cron invocation and starving every stage behind it
    // (head-of-line blocking). NULL ⇒ no time limit (the maxRows cap still bounds
    // the run). Distinct from maxRows so a fast phone can still drain many rows
    // within its slice while a slow one simply yields sooner.
    maxDurationMs?: number;
    // Overrides the provider's per-second send `rate` (parallel slice size +
    // pacing target). Production resolves it from max_sends_per_second; this is
    // the test injection point (1 = effectively serial).
    concurrency?: number;
    // PER-PHONE pacer, shared by every stage on the same sending number. The
    // carrier's `max_sends_per_second` is a limit on the NUMBER, and same-phone
    // stages now drain CONCURRENTLY, so a pacer private to one drain would let N
    // concurrent stages emit N × rate. The scheduler builds one bucket per phone
    // group and passes it here. Omitted ⇒ a private bucket at this stage's own
    // rate (the manual/single-stage path, and every existing test).
    bucket?: TokenBucket;
    // ORG-WIDE in-flight dedup set, shared across the whole invocation. The
    // 1-hour gate below reads COMMITTED 'sent' rows plus this set; without a
    // shared set two concurrent slices (same phone or different phones) could
    // both pass the same number in the window between dispatch and commit.
    // Keyed `${orgId}:${phone}`. Omitted ⇒ a private set (per-drain scope).
    seenPhones?: Set<string>;
    // Per-invocation memo for the 24h rolling count (the drain's slowest
    // preamble statement). Omitted ⇒ the un-memoized read, unchanged.
    sentSinceMemo?: SentSinceMemo;
  },
): Promise<DrainResult> {
  const isEnabled = opts.isEnabled ?? envSendEnabled;
  const isOrgEnabled =
    opts.isOrgEnabled ?? ((orgId: string) => getOrgSendsEnabled(dbc, orgId));
  const isOrgPaused =
    opts.isOrgPaused ?? ((orgId: string) => getOrgSendsPaused(dbc, orgId));

  const ctx = (await dbc.execute(sql`
    SELECT s.sms_provider_id AS provider_id,
           p.sms_provider_id AS provider_key,
           s.send_approved    AS send_approved,
           c.id               AS campaign_id,
           c.org_id           AS org_id,
           c.brand_id         AS brand_id,
           c.send_paused      AS campaign_send_paused,
           s.provider_phone_id AS provider_phone_id,
           p.send_paused           AS send_paused,
           p.max_sends_per_run     AS max_sends_per_run,
           p.max_sends_per_minute  AS max_sends_per_minute,
           p.max_sends_per_24h     AS max_sends_per_24h,
           -- Per-second rate lives on the PHONE (carrier limit, differs by number
           -- type within one provider). Resolved from the stage's chosen phone.
           pp.max_sends_per_second AS max_sends_per_second,
           pp.phone_number         AS sender_number
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
    LEFT JOIN provider_phones pp ON pp.id = s.provider_phone_id
    WHERE s.id = ${opts.stageId}
    LIMIT 1
  `)) as unknown as {
    provider_id: number | null;
    provider_key: string | null;
    send_approved: boolean;
    campaign_id: number;
    org_id: string;
    brand_id: number | null;
    campaign_send_paused: boolean | null;
    provider_phone_id: number | null;
    send_paused: boolean | null;
    max_sends_per_run: number | null;
    max_sends_per_minute: number | null;
    max_sends_per_24h: number | null;
    max_sends_per_second: number | null;
    sender_number: string | null;
  }[];

  const stage = ctx[0];
  if (!stage) return { ok: false, reason: "not_found", ...EMPTY };
  if (!stage.send_approved) return { ok: false, reason: "not_approved", ...EMPTY };
  // Two-switch gate (Workstream 1): the env SEND_ENABLED backstop AND the
  // DB-backed daily on/off must BOTH be on. Distinct refusal reasons so the UI
  // can tell the operator which one to flip.
  if (!isEnabled()) return { ok: false, reason: "send_disabled", ...EMPTY };
  if (!(await isOrgEnabled(stage.org_id)))
    return { ok: false, reason: "send_disabled_org", ...EMPTY };
  // Emergency hard-stop (org_settings.sends_paused): refuse before claiming
  // anything. Independent of the daily on/off — one click on the "Today's sends"
  // screen engages it; clearing it ("Proceed") lets sending resume.
  if (await isOrgPaused(stage.org_id))
    return { ok: false, reason: "send_paused_org", ...EMPTY };
  // Latching circuit breaker: refuse before claiming anything. A human must
  // resume via the provider UI; nothing here clears it.
  if (stage.send_paused) return { ok: false, reason: "provider_paused", ...EMPTY };
  // P7/P8: per-campaign latch (opt-out-rate breaker or manual). Independent of the
  // provider latch — this refuses only THIS campaign; siblings keep sending.
  if (stage.campaign_send_paused) return { ok: false, reason: "campaign_paused", ...EMPTY };
  if (stage.provider_id == null) return { ok: false, reason: "no_provider", ...EMPTY };

  const apiKey = await resolveKeyForStage(dbc, {
    orgId: stage.org_id,
    providerId: stage.provider_id,
    brandId: stage.brand_id,
    providerPhoneId: stage.provider_phone_id,
  });
  if (!apiKey) return { ok: false, reason: "no_credentials", ...EMPTY };

  let sendSms: Sender;
  // Resolved alongside sendSms, once, and reused for the per-attempt redaction
  // below. When a sender is injected (verify-drain's test seam),
  // resolveSenderForStage never calls getAdapter — its synthetic sms_providers
  // rows carry a disposable unique key (needed to satisfy the DB's
  // sms_provider_id UNIQUE constraint across many isolated breaker-test
  // providers), not a real "texthub"/"ahoi" key. Redaction is audit evidence
  // only, so the injected path keeps the raw TextHub URL shape (pre-registry
  // behavior, G2) instead of requiring a registry hit. A real (non-injected)
  // drain always resolves the adapter above first and would already have
  // returned `unknown_provider` before ever reaching a send.
  let buildRedacted: (p: NormalizedSendParams) => string;
  try {
    sendSms = resolveSenderForStage(stage.provider_key ?? "", opts.sendSms);
    buildRedacted = opts.sendSms
      ? (p) => buildSendUrl({ apiKey: p.apiKey, text: p.text, number: p.recipientE164, leadId: p.leadId })
      : (p) => getAdapter(stage.provider_key ?? "").buildRedactedRequest(p);
  } catch (e) {
    if (e instanceof UnknownProviderError) return { ...EMPTY, ok: false, reason: "unknown_provider" };
    throw e;
  }

  const providerId = stage.provider_id;
  const orgId = stage.org_id;
  // SOFT per-invocation pacing cap (clamped) drives the loop bound. opts.maxRows
  // still wins when injected (tests). Reaching it leaves rows pending for the
  // next tick — NOT a pause.
  const pacingCap = resolvePacingCap(stage.max_sends_per_run);
  const effectiveMaxRows = opts.maxRows ?? pacingCap;
  const minuteCap = resolveMinuteCap(stage.max_sends_per_minute);
  const cap24h = resolve24hCap(stage.max_sends_per_24h);
  // HARD per-second rate (from the stage's PHONE NUMBER — a carrier limit that
  // differs by number type): the drain fires up to `rate` sends in parallel, then
  // paces so a slice of N occupies N/rate seconds — never bursting above the
  // number's instantaneous limit. NULL phone/rate ⇒ default. opts.concurrency
  // overrides for tests.
  const rate = Math.max(1, opts.concurrency ?? resolveSendsPerSecond(stage.max_sends_per_second));
  // Pacing now lives in a bucket instead of a trailing per-slice sleep. Shared
  // (per-phone, injected) whenever several stages sit on one number; private
  // otherwise. See lib/sends/token-bucket.ts for why the old sleep was dead code
  // on any phone above 50/s.
  const bucket = opts.bucket ?? makeTokenBucket(rate);
  // Resolved once per drain (memoized process-wide) — see hasLatencyColumn.
  const withLatency = await hasLatencyColumn(dbc);
  // Rows per claimed batch, sized as ~BATCH_SECONDS of THIS phone's sending so
  // the fixed ~2.3s preamble is amortized at any rate. Explicit opts.batchSize
  // still wins (tests pin it).
  const batchSize = opts.batchSize ?? resolveDrainBatchSize(rate);
  const seenPhones = opts.seenPhones ?? new Set<string>();

  let sent = 0;
  let failed = 0;
  let filtered = 0;
  let skippedDuplicate = 0;
  let skippedOptedOut = 0;
  let processed = 0;
  let halted = false;
  let stopReason: DrainStopReason | null = null;
  let pausedNow = false;
  let consecutiveFailures = 0;
  // Wall-clock anchor for the fairness time-box (opts.maxDurationMs). Real time,
  // NOT the logical `now` used elsewhere — this measures how long THIS drain has
  // actually run so it can yield its slice to the next stage.
  const drainStartedAt = Date.now();

  while (processed < effectiveMaxRows) {
    // FAIRNESS TIME-BOX: yield BEFORE claiming the next batch once this stage has
    // used its wall-clock slice. Leaves remaining rows 'pending' (soft stop, like
    // the pacing cap) so they resume next tick — never abandons a claimed batch.
    if (opts.maxDurationMs != null && Date.now() - drainStartedAt >= opts.maxDurationMs) {
      break;
    }

    // Re-check the kill-switch BEFORE each batch so flipping it off stops the
    // drain (subject to the env-immutability caveat above).
    if (!isEnabled()) {
      halted = true;
      break;
    }

    // DB master switch is runtime-mutable (unlike the env var): a fresh read each
    // batch gives a TRUE mid-run kill — flipping "Live SMS sending" off in
    // Settings halts the in-flight drain at the next batch boundary.
    if (!(await isOrgEnabled(orgId))) {
      halted = true;
      stopReason = "org_disabled";
      break;
    }

    // Emergency hard-stop is runtime-mutable too: clicking the "Today's sends"
    // hard-stop flips sends_paused, and this fresh read halts the in-flight drain
    // at the next batch boundary before any new claim.
    if (await isOrgPaused(orgId)) {
      halted = true;
      stopReason = "org_paused";
      break;
    }

    // True mid-run kill: a concurrent pause (auto-trip or manual panic) halts
    // the in-flight drain at the next batch boundary, before any new claim.
    if (await isProviderPaused(dbc, providerId)) {
      halted = true;
      stopReason = "paused";
      break;
    }
    // P7/P8: same mid-run kill for the per-campaign latch — a breaker trip or
    // manual campaign pause halts THIS stage at the next batch boundary.
    if (await isCampaignPaused(dbc, stage.campaign_id)) {
      halted = true;
      stopReason = "paused";
      break;
    }

    // SOFT rolling ceilings — stop the run (leave rows pending), do NOT pause.
    // Counted per-provider incl. this run's own sends, so the rate self-throttles
    // without one provider's volume tripping another provider's ceiling.
    //
    // The 60s count stays a FRESH read (1.5ms server-side, and a one-minute
    // window genuinely moves within a tick). The 24h count is the drain's single
    // slowest statement (59.29ms) and the only one that scales with history, so
    // it goes through the per-invocation memo when one is supplied — which still
    // folds in this run's own sends and reads through near the cap, so the
    // ceiling behaves identically. See makeSentSinceMemo.
    if (ceilingBreached(await countSentSince(dbc, orgId, providerId, 60), minuteCap)) {
      stopReason = "rate_minute";
      break;
    }
    const count24h = opts.sentSinceMemo
      ? await opts.sentSinceMemo.count(dbc, orgId, providerId, 86_400, cap24h)
      : await countSentSince(dbc, orgId, providerId, 86_400);
    if (ceilingBreached(count24h, cap24h)) {
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
      RETURNING id, phone, rendered_text, lead_id, contact_id
    `)) as unknown as ClaimedRow[];

    if (claimed.length === 0) break;

    // ── SEND-TIME OPT-OUT INVARIANT (global, org-wide) ──────────────────────
    // Opt-outs are filtered into the frozen stage_sends set at MATERIALIZATION
    // time only. A recipient can STOP at any point in the (possibly hours-long,
    // pacing-limited) window between materialization and this dispatch: the
    // ingesters record it in opt_outs, but the already-'pending' row would still
    // fire. Re-check opt_outs at the moment of claim so a post-materialization
    // STOP is honored. Violators are marked 'skipped_opted_out' — terminal, and
    // DISTINCT from provider rejects (failed/filtered) and manual aborts
    // (rejected) so stage stats can count STOP-cancels separately — and never
    // dispatched. Structurally mirrors the 1-hour dedup gate below.
    const claimedContactIds = [...new Set(claimed.map((c) => c.contact_id))];
    const optedOutRows = (await dbc.execute(sql`
      SELECT DISTINCT contact_id FROM opt_outs
      WHERE org_id = ${orgId}
        AND contact_id IN (${sql.join(claimedContactIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `)) as unknown as { contact_id: string }[];
    const optedOut = new Set(optedOutRows.map((r) => r.contact_id));
    const notOptedOut: ClaimedRow[] = [];
    const optOutIds: string[] = [];
    for (const c of claimed) {
      if (optedOut.has(c.contact_id)) optOutIds.push(c.id);
      else notOptedOut.push(c);
    }
    if (optOutIds.length > 0) {
      await dbc.execute(sql`
        UPDATE stage_sends
        SET status = 'skipped_opted_out',
            last_error = 'opt_out_cancel'
        WHERE id IN (${sql.join(optOutIds.map((id) => sql`${id}::uuid`), sql`, `)})
      `);
      skippedOptedOut += optOutIds.length;
    }
    // Whole batch had opted out — claim the next batch (these rows left the
    // 'pending' set, so we still make progress and can't loop forever).
    if (notOptedOut.length === 0) continue;

    // ── HARD 1-hour send-dedup gate (global, org-wide) ──────────────────────
    // Before sending, drop any claimed row whose phone already received a message
    // within SEND_DEDUP_WINDOW_MS — across ANY campaign/stage. This is the safety
    // net against split-materialization bugs, cross-campaign overlap, and rapid
    // drips: a number never gets two messages inside the window. Violators are
    // marked 'skipped_duplicate' (terminal) and never dispatched. Two sources:
    //   (a) already-'sent' rows in the DB within the window (incl. this run's
    //       earlier slices, which committed sent_at per slice), and
    //   (b) a phone this INVOCATION has already dispatched to — tracked in
    //       `seenPhones`, keyed `${orgId}:${phone}`.
    //
    // (b) used to be a set scoped to ONE batch. That closed the intra-batch case
    // only: two in-flight slices (now genuinely concurrent — same-phone stages
    // drain in parallel, and phone groups always did) could both read the
    // committed-'sent' probe BEFORE either slice's UPDATE landed and both pass
    // the same number. Promoting the set to the whole invocation closes that race
    // on the dispatch side; the CROSS-invocation case is closed by the per-phone
    // lease (lib/sends/scheduled.ts). Direction of error is conservative: a phone
    // attempted earlier in the run is skipped even if that attempt failed —
    // never a double-text.
    const batchPhones = [...new Set(notOptedOut.map((c) => c.phone))];
    const recentRows = (await dbc.execute(sql`
      SELECT DISTINCT phone FROM stage_sends
      WHERE org_id = ${orgId}
        AND status = 'sent'
        AND sent_at >= now() - interval '1 millisecond' * ${SEND_DEDUP_WINDOW_MS}
        AND phone IN (${sql.join(batchPhones.map((p) => sql`${p}`), sql`, `)})
    `)) as unknown as { phone: string }[];
    const recentPhones = new Set(recentRows.map((r) => r.phone));
    const toSend: ClaimedRow[] = [];
    const skipIds: string[] = [];
    for (const c of notOptedOut) {
      const seenKey = `${orgId}:${c.phone}`;
      if (recentPhones.has(c.phone) || seenPhones.has(seenKey)) {
        skipIds.push(c.id);
      } else {
        seenPhones.add(seenKey);
        toSend.push(c);
      }
    }
    if (skipIds.length > 0) {
      await dbc.execute(sql`
        UPDATE stage_sends
        SET status = 'skipped_duplicate',
            last_error = 'dedup: phone messaged within 1h window'
        WHERE id IN (${sql.join(skipIds.map((id) => sql`${id}::uuid`), sql`, `)})
      `);
      skippedDuplicate += skipIds.length;
    }
    // Whole batch was duplicates — claim the next batch (skipped rows left the
    // 'pending' set, so we make progress and can't loop forever).
    if (toSend.length === 0) continue;

    // Build the redacted request shape once per batch — same URL TextHub gets,
    // but with a placeholder key so the api_key is NEVER persisted (the real key
    // is only ever passed to sendSms below).
    const keyLast4 = apiKey.slice(-4);

    // Fire each slice of `rate` TextHub sends in parallel (the ~400ms
    // per-recipient round-trip was the original ~2 sends/sec bottleneck), then
    // PERSIST the whole slice in BULK: at most two UPDATEs (sent / failed-or-
    // filtered) + one multi-row send_attempts INSERT — instead of 2 round-trips
    // per recipient. BOTH layers matter: parallel sends ALONE left ~20 serial
    // writes per slice dominating (measured ~2.5 sends/sec live); bulk writes cut
    // that to ~3 statements per slice. Every statement is a SINGLE query (never
    // concurrent on one connection), so this is correct whether `dbc` is the pool
    // (cron/drain) or a single-connection tx (tests). Counting + the failure-spike
    // breaker fold the results IN CLAIMED ORDER afterward (JS only), so
    // consecutive-failure semantics are unchanged; a slice's sends have all
    // already fired/persisted by the time the breaker trips (≤ `rate`-1 sends
    // past the threshold — an acceptable widening of a heuristic stop). BEFORE
    // each slice we take its budget from the per-phone token bucket, which is
    // what actually enforces `max_sends_per_second` across every stage on the
    // number (the old trailing sleep could not — see lib/sends/token-bucket.ts).
    // How far into `toSend` we have actually DISPATCHED (and persisted). Anything
    // past this that we claimed must be returned to 'pending' before we leave.
    let dispatchedUpTo = 0;
    let timedOutSlice = false;
    for (let off = 0; off < toSend.length && !stopReason; off += rate) {
      // FAIRNESS TIME-BOX at SLICE granularity. Checked between batches only, a
      // batch now sized at ~BATCH_SECONDS of sending would overshoot the slice's
      // wall-clock budget by most of a batch. Checking here is safe because it
      // is POST-PERSIST (the previous slice is fully written) and the rows we
      // have claimed but not yet dispatched are handed straight back to
      // 'pending' below — they were never sent, so at-most-once holds.
      //
      // `off > 0` — a claimed batch ALWAYS dispatches at least one slice. Without
      // it, a time-box shorter than the batch preamble would claim rows, send
      // none, release them, and repeat forever: zero forward progress on every
      // tick. Overshoot is therefore bounded to one slice (≤ `rate` messages ≈ 1s
      // of the phone's output), not a whole batch.
      if (off > 0 && opts.maxDurationMs != null && Date.now() - drainStartedAt >= opts.maxDurationMs) {
        timedOutSlice = true;
        break;
      }
      const slice = toSend.slice(off, off + rate);
      // Take the slice's budget from the PER-PHONE bucket, then fire it. The
      // burst shape is deliberately UNCHANGED from the sleep this replaced (up to
      // `rate` in parallel, then wait out the second) — see the "emission shape"
      // note in lib/sends/token-bucket.ts for why smoothing it is not free here.
      await bucket.take(slice.length);
      const results = await Promise.all(
        slice.map((c) =>
          sendSms({
            apiKey, text: c.rendered_text, number: c.phone, leadId: c.lead_id,
            senderNumber: stage.sender_number,
          }),
        ),
      );

      // Partition by outcome (claimed order preserved by index).
      const sentVals: SQL[] = [];
      const failVals: SQL[] = [];
      for (let k = 0; k < slice.length; k++) {
        const c = slice[k];
        const res = results[k];
        if (res.ok) {
          sentVals.push(sql`(${c.id}::uuid, ${res.messageId}::text)`);
        } else {
          // A structured {"status":"Suppressed"} rejection is recorded as
          // 'filtered' — a distinct, operator-visible bucket — instead of 'failed'
          // (label only: the row is NOT opted out and NOT skipped next time).
          const st = res.suppressed ? "filtered" : "failed";
          failVals.push(sql`(${c.id}::uuid, ${st}::text, ${res.error}::text)`);
        }
      }

      // attempts is incremented per row; the RETURNING value is the freshly
      // incremented number used as send_attempts.attempt_number (retries stack).
      const attemptsById = new Map<string, number>();
      if (sentVals.length > 0) {
        const upd = (await dbc.execute(sql`
          UPDATE stage_sends AS s
          SET status = 'sent', texthub_message_id = v.mid,
              sent_at = now(), attempts = s.attempts + 1
          FROM (VALUES ${sql.join(sentVals, sql`, `)}) AS v(id, mid)
          WHERE s.id = v.id
          RETURNING s.id, s.attempts
        `)) as unknown as { id: string; attempts: number }[];
        for (const r of upd) attemptsById.set(r.id, Number(r.attempts));
      }
      if (failVals.length > 0) {
        const upd = (await dbc.execute(sql`
          UPDATE stage_sends AS s
          SET status = v.st, last_error = v.err, attempts = s.attempts + 1
          FROM (VALUES ${sql.join(failVals, sql`, `)}) AS v(id, st, err)
          WHERE s.id = v.id
          RETURNING s.id, s.attempts
        `)) as unknown as { id: string; attempts: number }[];
        for (const r of upd) attemptsById.set(r.id, Number(r.attempts));
      }

      // One immutable evidence row per attempt (Workstream 3): verbatim body +
      // normalized result + classification, in claimed order. Bulk-inserted.
      const attVals = slice.map((c, k) => {
        const res = results[k];
        const classification = classifyAttempt({
          ok: res.ok,
          status: res.status,
          messageId: res.messageId,
          timedOut: res.timedOut,
        });
        const requestRedacted = buildRedacted({
          apiKey: `redacted_${keyLast4}`,
          text: c.rendered_text,
          recipientE164: c.phone,
          senderNumber: stage.sender_number,
          leadId: c.lead_id,
        });
        const attemptNumber = attemptsById.get(c.id) ?? 1;
        const base = sql`${orgId}, ${c.id}, ${attemptNumber}, ${requestRedacted}, ${res.status},
                    ${res.rawBody}, ${res.ok}, ${res.messageId}, ${res.error}, ${classification}`;
        return withLatency
          ? sql`(${base}, ${res.latencyMs ?? null})`
          : sql`(${base})`;
      });
      // CHUNKED: a slice can be up to ABSOLUTE_MAX_SENDS_PER_SECOND rows wide and
      // every row carries a verbatim provider body, so one statement per slice
      // could become enormous. Each chunk is still ONE round-trip, so this costs
      // nothing at real rates (60/s ⇒ 1 chunk).
      for (const part of chunk(attVals, ATTEMPTS_INSERT_CHUNK)) {
        await dbc.execute(sql`
          INSERT INTO send_attempts
            (org_id, stage_send_id, attempt_number, request_redacted, http_status,
             raw_body, ok, message_id, error, classification${withLatency ? sql`, latency_ms` : sql``})
          VALUES ${sql.join(part, sql`, `)}
        `);
      }

      // Count + failure-spike breaker, folded IN CLAIMED ORDER (JS only). The
      // whole slice's rows are already persisted above, so we count every fired
      // send even when the breaker trips mid-slice; the `!stopReason` guard just
      // stops claiming/sending FURTHER slices (latch once).
      for (let k = 0; k < slice.length; k++) {
        const res = results[k];
        processed++;
        if (res.ok) {
          sent++;
          consecutiveFailures = 0;
        } else {
          if (res.suppressed) filtered++;
          else failed++;
          // A non-OK send still feeds the failure-spike breaker regardless of the
          // suppression flag — unchanged from prior behavior.
          consecutiveFailures++;
        }
        if (!stopReason && shouldTripFailureSpike(consecutiveFailures)) {
          // Failure spike → latch the pause (creds/provider likely broken; stop
          // wasting calls). Remaining unclaimed rows stay pending for review.
          pausedNow = await latchPause(dbc, {
            providerId,
            orgId,
            reason: `failure_spike: ${consecutiveFailures} consecutive send failures`,
          });
          halted = true;
          stopReason = "failure_spike";
        }
      }

      // Fold this slice's sends into the 24h memo so its cached value keeps
      // self-throttling exactly like the un-memoized read did.
      opts.sentSinceMemo?.addSent(orgId, providerId, slice.length);
      dispatchedUpTo = off + slice.length;
    }

    // RELEASE THE UNDISPATCHED REMAINDER. A slice-boundary yield (or a hard stop
    // latched mid-batch) leaves the tail of this claim in 'sending' with NO send
    // attempted. Hand those rows straight back to 'pending' so they resume next
    // tick instead of stranding until reconcileStuckStages marks them 'failed'.
    // At-most-once is untouched: only rows we provably never dispatched are
    // reverted (`AND status = 'sending'` — anything already resolved is skipped).
    const undispatched = toSend.slice(dispatchedUpTo);
    if (undispatched.length > 0) {
      await dbc.execute(sql`
        UPDATE stage_sends SET status = 'pending'
        WHERE status = 'sending'
          AND id IN (${sql.join(undispatched.map((c) => sql`${c.id}::uuid`), sql`, `)})
      `);
      // These numbers were never messaged — take them back out of the in-flight
      // dedup set so the next tick isn't told they already got one.
      for (const c of undispatched) seenPhones.delete(`${orgId}:${c.phone}`);
    }

    if (timedOutSlice || stopReason) break;
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
        `stage: ${opts.stageId} · sent ${sent}, failed ${failed}, filtered ${filtered}, stuck ${stuck}, remaining ${remaining}\n` +
        `Sending is now PAUSED for this provider — resume manually after fixing the cause.`,
    );
  }

  // Dedup warning: numbers excluded because they were already messaged within the
  // 1-hour window. Not an error — a safety net firing — but surfaced so a bug or
  // an over-aggressive schedule that would double-text people is visible.
  if (skippedDuplicate > 0) {
    await notifyTelegram(
      `⚠️ Send dedup: ${skippedDuplicate} number(s) SKIPPED (already messaged within 1h)\n` +
        `stage: ${opts.stageId} · provider ${providerId} (org ${orgId})\n` +
        `sent ${sent}, skipped_duplicate ${skippedDuplicate}, remaining ${remaining}\n` +
        `These were excluded from sending, not opted out. Review the stage if unexpected.`,
    );
  }

  return {
    ok: true,
    sent,
    failed,
    filtered,
    skippedDuplicate,
    skippedOptedOut,
    processed,
    halted,
    stuck,
    remaining,
    stopReason,
    pausedNow,
  };
}
