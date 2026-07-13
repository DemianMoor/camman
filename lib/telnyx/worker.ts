import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";

import type { ClassifierContext } from "../carrier/classify";
import { loadClassifierContext } from "../carrier/classify-context";
import { normalizeCarrierKey } from "../carrier/normalize-key";
import { enqueueUnresolved, type TriageEntry } from "../carrier/triage-queue";
import { buildLookupRowFromTelnyx } from "./build-lookup-row";
import { telnyxBalance, telnyxNumberLookup } from "./client";
import { actualLookupCost } from "./cost";
import { countAttemptsToday, remainingCap } from "./daily-cap";
import {
  claimWorkerLease,
  releaseWorkerLease,
  renewWorkerLease,
} from "./lease";
import { loadLookupSettings } from "./settings";
import { formatBatchSummary } from "./summary";
import { syncContactsForPhones } from "./sync-contacts";

const BUDGET_MS = 250_000; // stay comfortably under the 300s maxDuration
const RENEW_EVERY_MS = 60_000;
const RETRY_COOLDOWN_SECONDS = 60; // a 429'd row isn't re-claimed until it ages out
const MAX_ATTEMPTS = 3;
const CLAIM_MAX = 50; // per iteration, further capped by rps + remaining cap

export type WorkerReason =
  | "no_lease"
  | "paused"
  | "cap_reached"
  | "balance_low"
  | "balance_error"
  | "lease_lost"
  | "budget"
  | "no_work"
  | "done";

export interface WorkerResult {
  ran: boolean;
  reason: WorkerReason;
  attempted: number;
  processed: number;
  failed: number;
  batchesCompleted: number;
}

interface ClaimedRow {
  id: string;
  phone: string;
  attempts: number;
}

export async function runLookupWorker(now: Date = new Date()): Promise<WorkerResult> {
  // 1. Single-runner lease (pooler-safe row lease, not an advisory lock).
  let lease = await claimWorkerLease(now);
  if (!lease) {
    return { ran: false, reason: "no_lease", attempted: 0, processed: 0, failed: 0, batchesCompleted: 0 };
  }
  let lastRenew = Date.now();
  const startMs = Date.now();
  let attempted = 0;
  let processed = 0;
  let failed = 0;

  try {
    // 2. Guards, in order: paused -> daily cap -> balance.
    const settings = await loadLookupSettings();
    if (settings.lookup_paused) return finish("paused");

    const used = await countAttemptsToday(now);
    let remaining = remainingCap(settings.lookup_daily_cap, used);
    if (remaining <= 0) return finish("cap_reached");

    const rps = Math.max(1, Math.min(50, settings.lookup_concurrency_rps));
    const rates = { base: settings.lookup_rate_base, mobile: settings.lookup_rate_mobile };

    // Only spend a balance call / drain if there's actual work.
    const pending = await countPendingClaimable();
    if (pending === 0) return finish("no_work");

    const bal = await telnyxBalance();
    if (!bal.ok) {
      await notifyTelegram(`⚠️ Telnyx balance check failed: ${bal.error}. Lookup drain skipped this run.`);
      return finish("balance_error");
    }
    // Cost of the next chunk at the worst (all-mobile) rate — pause if we can't cover it.
    const nextChunk = Math.min(rps, remaining, pending);
    const needed = nextChunk * (rates.base + rates.mobile);
    if (bal.availableCredit < needed) {
      await notifyTelegram(
        `🛑 Lookup paused: Telnyx balance $${bal.availableCredit.toFixed(2)} below required $${needed.toFixed(2)} — top up. (auto-resumes when balance recovers)`,
      );
      return finish("balance_low");
    }

    // Ledger reconciliation: snapshot balance-before on any batch about to drain
    // (only if not already set — a batch spanning runs keeps its first snapshot).
    await db.execute(sql`
      UPDATE lookup_batches SET balance_before_usd = ${bal.availableCredit}
      WHERE status IN ('pending', 'running') AND balance_before_usd IS NULL
    `);

    const ctx = await loadClassifierContext();

    // 3. Drain loop.
    while (remaining > 0 && Date.now() - startMs < BUDGET_MS) {
      // Heartbeat-renew the lease; stop if we lost it (stalled past expiry).
      if (Date.now() - lastRenew > RENEW_EVERY_MS) {
        const renewed = await renewWorkerLease(lease);
        if (!renewed) { lease = null; return finish("lease_lost"); }
        lease = renewed;
        lastRenew = Date.now();
      }

      const claimSize = Math.min(rps, remaining, CLAIM_MAX);
      const claimed = await claimQueueBatch(claimSize);
      if (claimed.length === 0) break; // nothing claimable right now
      attempted += claimed.length;
      remaining -= claimed.length;

      const iterStart = Date.now();
      const results = await Promise.all(claimed.map((r) => processOne(r, ctx)));

      const donePhones: string[] = [];
      const triage: TriageEntry[] = [];
      let fatal = false;
      for (const r of results) {
        if (r.kind === "done") {
          processed++;
          donePhones.push(r.phone);
          if (r.triage) triage.push(r.triage);
        } else if (r.kind === "failed") failed++;
        if (r.fatal) fatal = true;
      }
      // Sync contacts for the just-completed phones (copy down; landline cleanup).
      await syncContactsForPhones(donePhones);
      // Enqueue any unresolved carrier strings (v2) for async AI triage.
      if (ctx.v2 && triage.length > 0) await enqueueUnresolved(triage);

      if (fatal) {
        await notifyTelegram(
          `🛑 Lookup stopped: Telnyx returned a fatal error (balance/feature gate). Drain halted this run.`,
        );
        break;
      }

      // Pace to ~rps lookups/sec.
      const elapsed = Date.now() - iterStart;
      if (elapsed < 1000) await sleep(1000 - elapsed);
    }

    // 4. Finalize any batch whose queue is fully drained + Telegram summary.
    const completed = await finalizeCompletedBatches(rates);
    return finish("done", completed);
  } finally {
    if (lease) await releaseWorkerLease(lease);
  }

  function finish(reason: WorkerReason, batchesCompleted = 0): WorkerResult {
    return { ran: true, reason, attempted, processed, failed, batchesCompleted };
  }
}

// --- helpers ---

async function countPendingClaimable(): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM lookup_queue
    WHERE status = 'pending'
      AND (attempts = 0 OR updated_at < now() - (${RETRY_COOLDOWN_SECONDS} || ' seconds')::interval)
  `);
  return Number(rows[0]?.n ?? 0);
}

// Atomic claim: flip nothing, but increment attempts + stamp updated_at (each claim
// = one Telnyx call, counted toward the cap) under FOR UPDATE SKIP LOCKED so
// concurrent iterations never grab the same row. The cooldown keeps a just-attempted
// (e.g. 429'd) row out of the next claim until it ages out.
async function claimQueueBatch(size: number): Promise<ClaimedRow[]> {
  const rows = await db.execute<{ id: string; phone: string; attempts: number }>(sql`
    WITH c AS (
      SELECT id FROM lookup_queue
      WHERE status = 'pending'
        AND (attempts = 0 OR updated_at < now() - make_interval(secs => ${RETRY_COOLDOWN_SECONDS}))
      ORDER BY created_at, id
      LIMIT ${size}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE lookup_queue q SET attempts = attempts + 1, updated_at = now()
    FROM c WHERE q.id = c.id
    RETURNING q.id, q.phone, q.attempts
  `);
  return rows.map((r) => ({ id: r.id, phone: r.phone, attempts: r.attempts }));
}

type ProcessResult =
  | { kind: "done"; phone: string; triage?: TriageEntry; fatal?: false }
  | { kind: "retry"; fatal?: false }
  | { kind: "failed"; fatal: boolean };

async function processOne(row: ClaimedRow, ctx: ClassifierContext): Promise<ProcessResult> {
  const res = await telnyxNumberLookup(row.phone);
  if (res.ok) {
    const lookup = buildLookupRowFromTelnyx(row.phone, res.data, ctx);
    await upsertPhoneLookup(lookup);
    await db.execute(sql`UPDATE lookup_queue SET status = 'done', updated_at = now() WHERE id = ${row.id}::bigint`);
    // Unmapped -> queue the normalized key for AI triage (worker bulk-enqueues).
    const triage =
      lookup.carrier_norm === "Unmapped" && lookup.carrier_raw
        ? { matchKey: normalizeCarrierKey(lookup.carrier_raw), rawExample: lookup.carrier_raw }
        : undefined;
    return { kind: "done", phone: row.phone, triage };
  }
  // Fatal (balance/feature-gate): stop the whole run, don't retry-loop.
  const isFatal = res.status === 402 || /10038/.test(res.error);
  if (isFatal) {
    await db.execute(sql`UPDATE lookup_queue SET last_error = ${res.error}, updated_at = now() WHERE id = ${row.id}::bigint`);
    return { kind: "failed", fatal: true };
  }
  // Retryable and under the attempt cap -> leave pending (cooldown handles backoff).
  if (res.retryable && row.attempts < MAX_ATTEMPTS) {
    await db.execute(sql`UPDATE lookup_queue SET last_error = ${res.error}, updated_at = now() WHERE id = ${row.id}::bigint`);
    return { kind: "retry" };
  }
  // Terminal failure (bad number, or retries exhausted). No phone_lookups row is
  // written, so the contact stays 'Unidentified' (never successfully looked up).
  await db.execute(sql`UPDATE lookup_queue SET status = 'failed', last_error = ${res.error}, updated_at = now() WHERE id = ${row.id}::bigint`);
  return { kind: "failed", fatal: false };
}

async function upsertPhoneLookup(r: ReturnType<typeof buildLookupRowFromTelnyx>): Promise<void> {
  // Worker source is always 'telnyx', which overwrites any prior row (precedence).
  await db.execute(sql`
    INSERT INTO phone_lookups
      (phone, line_type, carrier_raw, carrier_norm, normalized_carrier, ocn, spid, ported, ported_date, source, lookup_status, raw_response, looked_up_at, updated_at)
    VALUES
      (${r.phone}, ${r.line_type}, ${r.carrier_raw ?? null}, ${r.carrier_norm}, ${r.normalized_carrier ?? null}, ${r.ocn ?? null}, ${r.spid ?? null},
       ${r.ported ?? null}, ${r.ported_date ?? null}, 'telnyx', 'complete', ${r.raw_response ? JSON.stringify(r.raw_response) : null}::jsonb, now(), now())
    ON CONFLICT (phone) DO UPDATE SET
      line_type = EXCLUDED.line_type, carrier_raw = EXCLUDED.carrier_raw, carrier_norm = EXCLUDED.carrier_norm,
      normalized_carrier = EXCLUDED.normalized_carrier,
      ocn = EXCLUDED.ocn, spid = EXCLUDED.spid, ported = EXCLUDED.ported, ported_date = EXCLUDED.ported_date,
      source = 'telnyx', lookup_status = 'complete', raw_response = EXCLUDED.raw_response,
      looked_up_at = now(), updated_at = now()
  `);
}

// Complete any pending/running batch whose queue has no more claimable/pending rows.
// Computes done/failed counts + actual cost from the line-type mix, sends a Telegram
// summary each. Returns the number of batches completed.
async function finalizeCompletedBatches(
  rates: { base: number; mobile: number },
): Promise<number> {
  const candidates = await db.execute<{ id: string; trigger: string; total_numbers: number; cache_hits: number; org_name: string | null; balance_before_usd: string | null }>(sql`
    SELECT b.id, b.trigger, b.total_numbers, b.cache_hits, b.balance_before_usd, o.name AS org_name
    FROM lookup_batches b
    LEFT JOIN organizations o ON o.id = b.org_id
    WHERE b.status IN ('pending', 'running')
      AND NOT EXISTS (SELECT 1 FROM lookup_queue q WHERE q.batch_id = b.id AND q.status = 'pending')
  `);
  if (candidates.length === 0) return 0;

  // Ledger truth: balance AFTER draining. billed = before - after (per batch).
  const after = await telnyxBalance();
  const balanceAfter = after.ok ? after.availableCredit : null;
  let completed = 0;
  for (const b of candidates) {
    const rows = await db.execute<{ status: string; line_type: string | null; n: string }>(sql`
      SELECT q.status, pl.line_type, count(*)::text AS n
      FROM lookup_queue q
      LEFT JOIN phone_lookups pl ON pl.phone = q.phone
      WHERE q.batch_id = ${b.id}::uuid
      GROUP BY q.status, pl.line_type
    `);
    const lineTypeCounts: Record<string, number> = {};
    let done = 0;
    let failedCount = 0;
    for (const r of rows) {
      const n = Number(r.n);
      if (r.status === "done") {
        done += n;
        if (r.line_type) lineTypeCounts[r.line_type] = (lineTypeCounts[r.line_type] ?? 0) + n;
      } else if (r.status === "failed") failedCount += n;
    }
    const actualCostUsd = actualLookupCost(lineTypeCounts, rates);
    const before = b.balance_before_usd != null ? Number(b.balance_before_usd) : null;
    const billedUsd =
      before != null && balanceAfter != null
        ? Math.round((before - balanceAfter) * 1e4) / 1e4
        : null;

    await db.execute(sql`
      UPDATE lookup_batches
      SET status = 'complete', processed = ${done}, failed = ${failedCount},
          actual_cost_usd = ${actualCostUsd}, balance_after_usd = ${balanceAfter}, updated_at = now()
      WHERE id = ${b.id}::uuid
    `);
    completed++;

    await notifyTelegram(
      formatBatchSummary({
        trigger: b.trigger,
        orgName: b.org_name ?? "org",
        total: b.total_numbers,
        cacheHits: b.cache_hits,
        processed: done,
        failed: failedCount,
        lineTypeCounts,
        actualCostUsd,
        billedUsd,
        balanceUsd: balanceAfter,
      }),
    );
  }
  return completed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
