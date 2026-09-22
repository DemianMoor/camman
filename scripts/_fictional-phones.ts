import { sql } from "drizzle-orm";

import type { db } from "../db/client";

// COLLISION-PROOF PHONE NUMBERS FOR TESTS THAT WRITE GLOBAL, PHONE-KEYED ROWS.
//
// phone_lookups (PK = phone) and lookup_queue carry no org_id: one row there is
// shared by every tenant, and csv_import UPSERTS on phone. Until 2026-09-22 the
// lookup tests used FIXED numbers (+12128675309, +12122000001, …) and cleaned
// up with `DELETE … WHERE phone = ANY(…)`, so a real row carrying one of those
// numbers would have been deleted, and an upsert would have overwritten it
// before that.
//
// Two defences, both needed:
//   • the numbers are NANP fictional numbers, 555-0100..555-0199, which are
//     reserved in every area code and never assigned to a subscriber. The area
//     code and the last two digits are random per run, so two runs, or a run and
//     a leftover, do not pick the same number;
//   • refuseIfPhonesInUse() stops the run BEFORE its first write if any chosen
//     number is already in any phone-keyed table a lookup test writes.
// The caller then deletes only the exact keys it inserted itself.

/** `n` distinct E.164 numbers of the form +1 NPA 555-01XX, NPA and XX random. */
export function fictionalPhones(n: number): string[] {
  const out = new Set<string>();
  while (out.size < n) {
    const npa = 200 + Math.floor(Math.random() * 800); // 200..999
    const xx = String(Math.floor(Math.random() * 100)).padStart(2, "0");
    out.add(`+1${npa}55501${xx}`);
  }
  return [...out];
}

/**
 * Throws if any of `phones` already exists in phone_lookups, lookup_queue or
 * contacts (any org) — the phone-keyed tables the lookup tests write, directly
 * or through syncContactsForPhones. Call it before the first write.
 */
export async function refuseIfPhonesInUse(conn: Pick<typeof db, "execute">, phones: string[]): Promise<void> {
  // One bound parameter per number (a JS array interpolated into sql`` would be
  // flattened, not bound as an array). No lib/telnyx import here: a caller may
  // need to neutralise the Telnyx key before any lib/telnyx module loads.
  const list = sql.join(phones.map((p) => sql`${p}`), sql`, `);
  const taken = (await conn.execute(sql`
    SELECT 'phone_lookups' AS tbl, phone FROM phone_lookups WHERE phone IN (${list})
    UNION ALL
    SELECT 'lookup_queue', phone FROM lookup_queue WHERE phone IN (${list})
    UNION ALL
    SELECT 'contacts', phone_number FROM contacts WHERE phone_number IN (${list})
  `)) as unknown as { tbl: string; phone: string }[];
  if (taken.length > 0) {
    throw new Error(
      `REFUSING TO START: test phone(s) already in use — ${taken.map((r) => `${r.tbl}:${r.phone}`).join(", ")}. ` +
        "Nothing was written. Re-run to draw new numbers.",
    );
  }
}
