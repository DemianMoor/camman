import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

import { normalizeCarrierKey } from "./normalize-key";

// Contacts still sitting at carrier_norm='Unmapped', aggregated by the NORMALIZED
// carrier key. Because the key is derived in JS (normalizeCarrierKey), the count
// can't be expressed in SQL against carrier_raw — we fetch the distinct raw strings
// with their contact counts and fold them into keys here. Used by the AI-triage
// high-volume alert and the admin review queue (both rank by contact_count).
export async function contactCountsByMatchKey(): Promise<Map<string, number>> {
  const rows = await db.execute<{ carrier_raw: string; cnt: number }>(sql`
    SELECT pl.carrier_raw, COUNT(c.id)::int AS cnt
    FROM phone_lookups pl
    JOIN contacts c ON c.phone_number = pl.phone AND c.carrier_norm = 'Unmapped'
    WHERE pl.carrier_norm = 'Unmapped' AND pl.carrier_raw IS NOT NULL
    GROUP BY pl.carrier_raw`);

  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = normalizeCarrierKey(r.carrier_raw);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + Number(r.cnt));
  }
  return counts;
}

// One-line current-state summary of the carrier-triage queue, for the daily
// Telegram report (brief §9). A single grouped COUNT over the small queue table.
export async function carrierTriageSummary(): Promise<{
  resolved: number;
  needsHuman: number;
  pending: number;
}> {
  const rows = await db.execute<{ status: string; n: number }>(sql`
    SELECT status, COUNT(*)::int AS n FROM carrier_classify_queue GROUP BY status`);
  const by = new Map(rows.map((r) => [r.status, Number(r.n)]));
  return {
    resolved: (by.get("ai_resolved") ?? 0) + (by.get("human_resolved") ?? 0),
    needsHuman: by.get("needs_human") ?? 0,
    pending: by.get("pending") ?? 0,
  };
}
