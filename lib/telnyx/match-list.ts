import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { validatePhonesBatch } from "@/lib/phone-validation";

import { pgArray } from "./pg-array";

// Chunked so a very large paste can't build an oversized array literal for a
// single query. (contacts is unique on (org_id, phone_number), so a matched phone
// maps to exactly one contact.)
const MATCH_CHUNK = 20_000;

export interface ListMatch {
  rows_in: number; // raw lines submitted
  unique_numbers: number; // distinct valid E.164 (same-list dupes collapsed)
  valid: number;
  invalid: number;
  matched: number; // exist as org contacts
  not_found: number; // valid but no contact — reported, NEVER created
  already_looked_up: number; // matched AND complete lookup (skipped, free)
  already_queued: number; // matched, not looked up, but already pending in a batch
  to_enqueue: number; // matched − already_looked_up − already_queued (what enqueues)
  matchedPhones: string[]; // E.164 that exist as contacts — server-side enqueue input
}

// Normalize + dedup a pasted/CSV list, match ONLY against existing org contacts
// (this NEVER creates contacts), and split the matched set into already-looked-up
// / already-queued / to-enqueue. Used by BOTH the preview and the enqueue route so
// the numbers an operator confirms are exactly the numbers that get enqueued.
export async function matchExistingContacts(
  orgId: string,
  rawLines: string[],
): Promise<ListMatch> {
  const rows_in = rawLines.length;
  const { valid, invalid } = validatePhonesBatch(rawLines);
  const unique = Array.from(new Set(valid.map((v) => v.normalized)));

  // Match against existing contacts (org-scoped). Not-found numbers are dropped
  // here and never touched again — no contact is created.
  const matchedSet = new Set<string>();
  for (let i = 0; i < unique.length; i += MATCH_CHUNK) {
    const chunk = unique.slice(i, i + MATCH_CHUNK);
    const rows = await db.execute<{ phone_number: string }>(sql`
      SELECT phone_number FROM contacts
      WHERE org_id = ${orgId}::uuid AND phone_number = ANY(${pgArray(chunk, "text")})
    `);
    for (const r of rows) matchedSet.add(r.phone_number);
  }
  const matchedPhones = [...matchedSet];
  const matched = matchedPhones.length;
  const not_found = unique.length - matched;

  // Of the matched numbers, how many are already looked up (complete) vs already
  // pending in a batch. to_enqueue is the honest remainder — the same set the
  // enqueue INSERT would create (cache-complete + already-pending both excluded).
  let already_looked_up = 0;
  let already_queued = 0;
  for (let i = 0; i < matchedPhones.length; i += MATCH_CHUNK) {
    const chunk = matchedPhones.slice(i, i + MATCH_CHUNK);
    const rows = await db.execute<{ looked_up: string; queued: string }>(sql`
      SELECT
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM phone_lookups pl
          WHERE pl.phone = p.phone AND pl.lookup_status = 'complete'
        ))::text AS looked_up,
        count(*) FILTER (
          WHERE NOT EXISTS (
            SELECT 1 FROM phone_lookups pl
            WHERE pl.phone = p.phone AND pl.lookup_status = 'complete'
          )
          AND EXISTS (
            SELECT 1 FROM lookup_queue q
            WHERE q.phone = p.phone AND q.status = 'pending'
          )
        )::text AS queued
      FROM (SELECT unnest(${pgArray(chunk, "text")}) AS phone) p
    `);
    already_looked_up += Number(rows[0]?.looked_up ?? 0);
    already_queued += Number(rows[0]?.queued ?? 0);
  }
  const to_enqueue = matched - already_looked_up - already_queued;

  return {
    rows_in,
    unique_numbers: unique.length,
    valid: valid.length,
    invalid: invalid.length,
    matched,
    not_found,
    already_looked_up,
    already_queued,
    to_enqueue,
    matchedPhones,
  };
}
