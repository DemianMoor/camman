import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { carrier_mappings } from "@/db/schema";

import type { CarrierBucket } from "../telnyx/assign-mapping";
import { normalizeCarrierKey } from "./normalize-key";

export interface CarrierMappingWrite {
  matchKey: string; // normalized key (carrier_classify_queue.match_key)
  rawExample: string; // a representative raw carrier string, stored as carrier_mappings.raw_name
  bucket: CarrierBucket;
  mappedBy: string; // provenance: 'ai' | 'human' | 'admin' | 'backfill'
}

export interface ApplyMappingResult {
  lookups_updated: number;
  contacts_updated: number;
}

// Shared write-back for BOTH AI triage and human assignment. For each (matchKey ->
// bucket): (1) upsert carrier_mappings so the v2 resolver (which keys on
// normalizeCarrierKey(raw_name) = matchKey) catches it forever after, and
// (2) RETROACTIVELY reclassify every phone_lookups row + contact still sitting at
// 'Unmapped' whose normalized carrier key equals matchKey — so ONE mapping fixes
// all route-suffix variants at once (brief acceptance criteria). Only 'Unmapped'
// rows are touched, so a manual correction is never clobbered. Batched: a single
// DISTINCT scan of the (bounded) unmapped strings covers the whole item set.
export async function applyCarrierMappings(
  items: CarrierMappingWrite[],
): Promise<ApplyMappingResult> {
  const keyToBucket = new Map<string, CarrierBucket>();
  for (const it of items) {
    const k = it.matchKey.trim();
    if (k) keyToBucket.set(k, it.bucket);
  }
  if (keyToBucket.size === 0) {
    return { lookups_updated: 0, contacts_updated: 0 };
  }

  return db.transaction(async (tx) => {
    // 1. Upsert the mappings (raw_name PK; last write wins on re-assignment).
    await tx
      .insert(carrier_mappings)
      .values(
        items.map((it) => ({
          raw_name: it.rawExample,
          carrier_norm: it.bucket,
          mapped_by: it.mappedBy,
        })),
      )
      .onConflictDoUpdate({
        target: carrier_mappings.raw_name,
        set: {
          carrier_norm: sql`excluded.carrier_norm`,
          mapped_by: sql`excluded.mapped_by`,
        },
      });

    // 2. Which distinct Unmapped raw strings normalize to a key we're assigning?
    const distinct = await tx.execute<{ carrier_raw: string }>(sql`
      SELECT DISTINCT carrier_raw FROM phone_lookups
      WHERE carrier_norm = 'Unmapped' AND carrier_raw IS NOT NULL`);

    const rawToBucket: { raw: string; bucket: CarrierBucket }[] = [];
    for (const row of distinct) {
      const bucket = keyToBucket.get(normalizeCarrierKey(row.carrier_raw));
      if (bucket) rawToBucket.push({ raw: row.carrier_raw, bucket });
    }
    if (rawToBucket.length === 0) {
      return { lookups_updated: 0, contacts_updated: 0 };
    }

    // VALUES (raw, bucket) join — single UPDATE covers every matching raw string.
    const valuesLit = sql.raw(
      rawToBucket
        .map(
          (m) =>
            `('${m.raw.replace(/'/g, "''")}','${m.bucket.replace(/'/g, "''")}')`,
        )
        .join(","),
    );

    const pl = await tx.execute<{ phone: string }>(sql`
      UPDATE phone_lookups pl SET carrier_norm = m.bucket, updated_at = now()
      FROM (VALUES ${valuesLit}) AS m(raw, bucket)
      WHERE pl.carrier_raw = m.raw AND pl.carrier_norm = 'Unmapped'
      RETURNING pl.phone`);

    const c = await tx.execute<{ id: string }>(sql`
      UPDATE contacts c SET carrier_norm = m.bucket, updated_at = now()
      FROM phone_lookups pl, (VALUES ${valuesLit}) AS m(raw, bucket)
      WHERE pl.phone = c.phone_number
        AND pl.carrier_raw = m.raw
        AND c.carrier_norm = 'Unmapped'
      RETURNING c.id`);

    return { lookups_updated: pl.length, contacts_updated: c.length };
  });
}

// Human assignment from the review queue: write the mapping (normalized key,
// retro-updating all suffix variants), then mark the queue row human_resolved.
export async function resolveQueueByHuman(
  matchKey: string,
  rawExample: string,
  bucket: CarrierBucket,
): Promise<ApplyMappingResult> {
  const res = await applyCarrierMappings([
    { matchKey, rawExample, bucket, mappedBy: "human" },
  ]);
  await db.execute(sql`
    UPDATE carrier_classify_queue
    SET status = 'human_resolved', updated_at = now()
    WHERE match_key = ${matchKey}`);
  return res;
}
