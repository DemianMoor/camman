import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { lookup_batches } from "@/db/schema";
import { validatePhone } from "@/lib/phone-validation";

import { estimateLookupCost, DEFAULT_MOBILE_SHARE } from "./cost";
import { pgArray } from "./pg-array";
import { loadLookupSettings, type LookupSettingsRow } from "./settings";

// NOTE: `lookup_batches.trigger` has a CHECK constraint limiting it to
// ('upload','backfill','csv_update'). The scoped targeted-lookup entry points
// (group / matched-list) enqueue under 'upload' — they ARE just another way a
// bounded set of numbers reaches the same queue, and reusing an allowed value
// keeps this a no-schema-change feature. Widen the CHECK (a migration) later if
// distinct batch labels become worth it.
export type LookupTrigger = "upload" | "backfill" | "csv_update";

export interface EnqueueResult {
  batchId: string;
  total: number; // distinct valid E.164 numbers requested
  cacheHits: number; // already in phone_lookups (complete) — free, not enqueued
  enqueued: number; // new queue rows created
  estCostUsd: number;
}

// Rate-based cost estimate shared by every enqueue path. Provisional — the truth
// is the batch's Est-vs-Billed ledger line computed at finalize (lib/telnyx/summary.ts).
function estCostFor(enqueued: number, settings: LookupSettingsRow): number {
  return estimateLookupCost(
    enqueued,
    { base: settings.lookup_rate_base, mobile: settings.lookup_rate_mobile },
    DEFAULT_MOBILE_SHARE,
  );
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

    const estCostUsd = estCostFor(enqueued, settings);
    await tx.execute(sql`
      UPDATE lookup_batches SET est_cost_usd = ${estCostUsd}, updated_at = now()
      WHERE id = ${batch.id}::uuid
    `);

    return { batchId: batch.id, total, cacheHits, enqueued, estCostUsd };
  });
}

// Enqueue a contact group's un-looked-up numbers, sourced set-based directly from
// the group join — never round-tripping phones through the app (a group can hold
// 100K+ contacts). Same batch + same lookup_queue INSERT with the identical
// cache-complete / already-pending guards as enqueueNormalized, so the worker
// drains it identically. `contacts` is unique on (org_id, phone_number), so the
// group's distinct-phone universe equals its contact count. Only 'active' groups.
export async function enqueueGroup(
  orgId: string,
  groupId: number,
  trigger: LookupTrigger,
): Promise<EnqueueResult> {
  const settings = await loadLookupSettings();

  return db.transaction(async (tx) => {
    // Batch bookkeeping: total = the group's distinct-phone universe; cache_hits =
    // those already looked up (complete). enqueued (below) = the rest, minus any
    // already pending in another batch.
    const uni = await tx.execute<{ total: string; cache_hits: string }>(sql`
      SELECT
        count(DISTINCT c.phone_number)::text AS total,
        count(DISTINCT c.phone_number)
          FILTER (WHERE pl.phone IS NOT NULL AND pl.lookup_status = 'complete')::text
          AS cache_hits
      FROM contact_contact_groups ccg
      JOIN contacts c ON c.id = ccg.contact_id
      JOIN contact_groups cg ON cg.id = ccg.contact_group_id
      LEFT JOIN phone_lookups pl ON pl.phone = c.phone_number
      WHERE ccg.org_id = ${orgId}::uuid
        AND ccg.contact_group_id = ${groupId}
        AND cg.status = 'active'
    `);
    const total = Number(uni[0]?.total ?? 0);
    const cacheHits = Number(uni[0]?.cache_hits ?? 0);

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

    const inserted = await tx.execute<{ phone: string }>(sql`
      INSERT INTO lookup_queue (batch_id, phone)
      SELECT ${batch.id}::uuid, d.phone
      FROM (
        SELECT DISTINCT c.phone_number AS phone
        FROM contact_contact_groups ccg
        JOIN contacts c ON c.id = ccg.contact_id
        JOIN contact_groups cg ON cg.id = ccg.contact_group_id
        WHERE ccg.org_id = ${orgId}::uuid
          AND ccg.contact_group_id = ${groupId}
          AND cg.status = 'active'
      ) d
      WHERE NOT EXISTS (
        SELECT 1 FROM phone_lookups pl
        WHERE pl.phone = d.phone AND pl.lookup_status = 'complete'
      )
      AND NOT EXISTS (
        SELECT 1 FROM lookup_queue q
        WHERE q.phone = d.phone AND q.status = 'pending'
      )
      RETURNING phone
    `);
    const enqueued = inserted.length;

    const estCostUsd = estCostFor(enqueued, settings);
    await tx.execute(sql`
      UPDATE lookup_batches SET est_cost_usd = ${estCostUsd}, updated_at = now()
      WHERE id = ${batch.id}::uuid
    `);

    return { batchId: batch.id, total, cacheHits, enqueued, estCostUsd };
  });
}
