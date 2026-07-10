import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { lookup_batches } from "@/db/schema";
import { validatePhone } from "@/lib/phone-validation";

import { estimateLookupCost, DEFAULT_MOBILE_SHARE } from "./cost";
import { pgArray } from "./pg-array";
import { loadLookupSettings } from "./settings";

export type LookupTrigger = "upload" | "backfill" | "csv_update";

export interface EnqueueResult {
  batchId: string;
  total: number; // distinct valid E.164 numbers requested
  cacheHits: number; // already in phone_lookups (complete) — free, not enqueued
  enqueued: number; // new queue rows created
  estCostUsd: number;
}

// Create a lookup_batch and enqueue the numbers that still need a lookup. Dedup at
// enqueue time: numbers already in phone_lookups (complete) count as cache hits and
// are NOT enqueued; numbers already pending in another batch are not double-enqueued.
// Phones are normalized to E.164 (+1XXXXXXXXXX) so they match the global cache key.
export async function enqueueLookups(
  orgId: string,
  rawPhones: string[],
  trigger: LookupTrigger,
): Promise<EnqueueResult> {
  // Normalize + dedup the input, then hand off the (already-E.164) set.
  const set = new Set<string>();
  for (const raw of rawPhones) {
    const p = validatePhone(raw);
    if (p.valid && p.normalized) set.add(p.normalized);
  }
  return enqueueNormalized(orgId, [...set], trigger);
}

// Enqueue a set of ALREADY-normalized E.164 phones (dedup + batch creation). Split
// out so callers with pre-validated numbers skip re-parsing and so the dedup logic
// is testable without libphonenumber.
export async function enqueueNormalized(
  orgId: string,
  phones: string[],
  trigger: LookupTrigger,
): Promise<EnqueueResult> {
  const total = phones.length;
  const settings = await loadLookupSettings();

  return db.transaction(async (tx) => {
    // Cache hits: already looked up (complete).
    const cacheRows = await tx.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM phone_lookups
      WHERE lookup_status = 'complete' AND phone = ANY(${pgArray(phones, "text")})
    `);
    const cacheHits = Number(cacheRows[0]?.n ?? 0);

    const [batch] = await tx
      .insert(lookup_batches)
      .values({
        org_id: orgId,
        trigger,
        total_numbers: total,
        cache_hits: cacheHits,
        status: "pending",
      })
      .returning({ id: lookup_batches.id });

    // Enqueue everything not already complete in the cache and not already pending
    // in any batch. One set-based INSERT ... SELECT.
    const inserted = await tx.execute<{ phone: string }>(sql`
      INSERT INTO lookup_queue (batch_id, phone)
      SELECT ${batch.id}::uuid, p.phone
      FROM (SELECT DISTINCT unnest(${pgArray(phones, "text")}) AS phone) p
      WHERE NOT EXISTS (
        SELECT 1 FROM phone_lookups pl
        WHERE pl.phone = p.phone AND pl.lookup_status = 'complete'
      )
      AND NOT EXISTS (
        SELECT 1 FROM lookup_queue q
        WHERE q.phone = p.phone AND q.status = 'pending'
      )
      RETURNING phone
    `);
    const enqueued = inserted.length;

    const estCostUsd = estimateLookupCost(
      enqueued,
      { base: settings.lookup_rate_base, mobile: settings.lookup_rate_mobile },
      DEFAULT_MOBILE_SHARE,
    );

    await tx.execute(sql`
      UPDATE lookup_batches SET est_cost_usd = ${estCostUsd}, updated_at = now()
      WHERE id = ${batch.id}::uuid
    `);

    return { batchId: batch.id, total, cacheHits, enqueued, estCostUsd };
  });
}
