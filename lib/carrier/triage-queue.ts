import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

import { pgArray } from "../telnyx/pg-array";

export interface TriageEntry {
  matchKey: string;
  rawExample: string;
}

// Enqueue distinct unresolved (Unmapped) carrier keys for async AI triage. Idempotent:
// ON CONFLICT (match_key) DO NOTHING preserves an existing row's status/attempts, so
// a string already ai_resolved / needs_human is never reset and never re-billed. A
// resolved string is no longer Unmapped (its mapping was written), so it won't re-enqueue.
export async function enqueueUnresolved(entries: TriageEntry[]): Promise<void> {
  const seen = new Map<string, string>();
  for (const e of entries) {
    const k = e.matchKey.trim();
    if (k && !seen.has(k)) seen.set(k, e.rawExample);
  }
  if (seen.size === 0) return;

  const keys = [...seen.keys()];
  const examples = keys.map((k) => seen.get(k) ?? k);
  await db.execute(sql`
    INSERT INTO carrier_classify_queue (match_key, raw_example)
    SELECT k, e FROM unnest(${pgArray(keys, "text")}, ${pgArray(examples, "text")}) AS t(k, e)
    ON CONFLICT (match_key) DO NOTHING
  `);
}
