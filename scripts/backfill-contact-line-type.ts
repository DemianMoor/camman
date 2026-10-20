// One-shot production backfill: copy phone_lookups.line_type / carrier_norm onto
// every contact whose copy is stale (migration 0218 prerequisite).
//
// Why they are stale: drip intake creates the contact AFTER its Telnyx lookup
// completed, and the worker's copy (lib/telnyx/sync-contacts.ts) only runs at
// lookup time — so it found no contact and every drip contact kept the default
// 'unknown' / 'Unidentified'. Measured 2026-10-20: 416,355 stale contacts
// (400,860 mobile, 15,456 voip, 27 toll_free, 12 landline). lib/drip/enrichment.ts
// now copies it at creation; this repairs the history.
//
// Writes through syncContactsForPhones — the worker's own copy path — so the
// landline cleanup is the same as for any fresh lookup: the messaging_status
// trigger fires, PENDING sends of a landline are filtered, and it leaves frozen
// audience pools.
//
//   npx tsx --conditions=react-server scripts/backfill-contact-line-type.ts           # dry run
//   npx tsx --conditions=react-server scripts/backfill-contact-line-type.ts --apply   # write
//
// Idempotent: keyset over contacts.id; a re-run finds nothing stale.
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { syncContactsForPhones } from "@/lib/telnyx/sync-contacts";

const BATCH = 2000;

async function staleSummary() {
  return (await db.execute(sql`
    SELECT pl.line_type AS cache, c.line_type AS contact, count(*)::int AS n
    FROM contacts c JOIN phone_lookups pl ON pl.phone = c.phone_number
    WHERE c.line_type IS DISTINCT FROM pl.line_type
       OR c.carrier_norm IS DISTINCT FROM pl.carrier_norm
    GROUP BY 1, 2 ORDER BY 3 DESC`)) as unknown as { cache: string; contact: string; n: number }[];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const before = await staleSummary();
  const total = before.reduce((a, r) => a + r.n, 0);
  console.log(`${apply ? "APPLY" : "DRY RUN"} — ${total} stale contact(s)`);
  console.table(before);
  if (!apply || total === 0) return;

  let last = "00000000-0000-0000-0000-000000000000";
  let updated = 0, cancelled = 0, pool = 0, batches = 0;
  for (;;) {
    const rows = (await db.execute(sql`
      SELECT c.id, c.phone_number
      FROM contacts c JOIN phone_lookups pl ON pl.phone = c.phone_number
      WHERE c.id > ${last}::uuid
        AND (c.line_type IS DISTINCT FROM pl.line_type
             OR c.carrier_norm IS DISTINCT FROM pl.carrier_norm)
      ORDER BY c.id LIMIT ${BATCH}`)) as unknown as { id: string; phone_number: string }[];
    if (rows.length === 0) break;
    last = rows[rows.length - 1].id;
    const r = await syncContactsForPhones([...new Set(rows.map((x) => x.phone_number))]);
    updated += r.contactsUpdated; cancelled += r.pendingSendsCancelled; pool += r.poolRemoved;
    if (++batches % 20 === 0) console.log(`  … ${updated} updated`);
  }
  console.log(`updated ${updated} contact(s) in ${batches} batch(es); landline pending sends filtered ${cancelled}; landline pool rows removed ${pool}`);

  const after = await staleSummary();
  const left = after.reduce((a, r) => a + r.n, 0);
  console.log(`stale remaining: ${left}`);
  if (left > 0) { console.table(after); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => process.exit());
