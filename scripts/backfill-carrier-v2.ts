// Carrier Normalization v2 backfill (brief §12).
//
//   npx tsx scripts/backfill-carrier-v2.ts            # DRY RUN (default) — writes nothing
//   npx tsx scripts/backfill-carrier-v2.ts --apply    # writes: normalized_carrier, carrier_norm, contacts
//
// Dry run: reports the before -> after carrier_norm bucket distribution over the
// whole phone_lookups cache using the v2 resolver chain, plus how many rows would
// change bucket — WITHOUT writing. Review this before flipping carrier_resolver_v2.
//
// Apply: (1) backfills phone_lookups.normalized_carrier from the retained
// raw_response (free, no Telnyx re-pay); (2) snapshots contacts.carrier_norm to a
// rollback table; (3) recomputes phone_lookups.carrier_norm via the shared chain
// in batches; (4) syncs the denormalized contacts.carrier_norm. Landlines are left
// at 'Unknown' (never carrier-segmented), matching the ingest path.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { classifyCarrier } from "@/lib/carrier/classify";
import { loadClassifierContext } from "@/lib/carrier/classify-context";
import { normalizeCarrierKey } from "@/lib/carrier/normalize-key";
import { enqueueUnresolved, type TriageEntry } from "@/lib/carrier/triage-queue";
import { extractTelnyxNormalized } from "@/lib/telnyx/build-lookup-row";
import type { CarrierNorm, TelnyxNumberLookupData } from "@/lib/telnyx/types";

const APPLY = process.argv.includes("--apply");
const BATCH = 5000;

type Row = {
  phone: string;
  line_type: string;
  carrier_raw: string | null;
  carrier_norm: string;
  raw_response: TelnyxNumberLookupData | null;
};

function tallyRow(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function printDist(label: string, m: Map<string, number>, total: number) {
  console.log(`\n${label}:`);
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = total ? ((v / total) * 100).toFixed(1) : "0.0";
    console.log(`  ${k.padEnd(14)} ${String(v).padStart(8)}  ${pct}%`);
  }
}

async function main() {
  console.log(`Carrier v2 backfill — ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);
  const ctx = await loadClassifierContext(true); // preview/apply always use v2 semantics

  if (APPLY) {
    // (1) normalized_carrier from raw_response — free, idempotent.
    const nc = await db.execute(sql`
      UPDATE phone_lookups
      SET normalized_carrier = COALESCE(
        NULLIF(TRIM(raw_response->'carrier'->>'normalized_carrier'), ''),
        NULLIF(TRIM(raw_response->>'normalized_carrier'), '')
      )
      WHERE normalized_carrier IS NULL AND raw_response IS NOT NULL`);
    console.log(`normalized_carrier backfilled where present in raw_response (rows scanned: ${nc.length ?? "n/a"})`);

    // (2) rollback snapshot of contacts.carrier_norm (only once).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS carrier_norm_backfill_snapshot (
        contact_id uuid PRIMARY KEY,
        carrier_norm text NOT NULL,
        snapped_at timestamptz NOT NULL DEFAULT now()
      )`);
    const snap = await db.execute(sql`
      INSERT INTO carrier_norm_backfill_snapshot (contact_id, carrier_norm)
      SELECT id, carrier_norm FROM contacts
      ON CONFLICT (contact_id) DO NOTHING`);
    console.log(`contacts.carrier_norm snapshot rows: ${snap.length ?? "(existing snapshot kept)"}`);
  }

  const before = new Map<string, number>();
  const after = new Map<string, number>();
  let changed = 0;
  let total = 0;
  let lastPhone = "";

  for (;;) {
    const rows = (await db.execute(sql`
      SELECT phone, line_type, carrier_raw, carrier_norm, raw_response
      FROM phone_lookups
      WHERE phone > ${lastPhone}
      ORDER BY phone
      LIMIT ${BATCH}`)) as unknown as Row[];
    if (rows.length === 0) break;
    lastPhone = rows[rows.length - 1].phone;

    const updates: { phone: string; norm: CarrierNorm }[] = [];
    const triage: TriageEntry[] = [];
    for (const r of rows) {
      total++;
      tallyRow(before, r.carrier_norm);
      const newNorm: CarrierNorm =
        r.line_type === "landline"
          ? "Unknown"
          : classifyCarrier(
              {
                telnyxNormalized: r.raw_response ? extractTelnyxNormalized(r.raw_response) : null,
                carrierName: r.carrier_raw,
              },
              ctx,
            ).carrier_norm;
      tallyRow(after, newNorm);
      if (newNorm !== r.carrier_norm) {
        changed++;
        updates.push({ phone: r.phone, norm: newNorm });
      }
      // Still unresolved -> enqueue for AI triage (so the review queue reflects reality).
      if (newNorm === "Unmapped" && r.carrier_raw) {
        triage.push({ matchKey: normalizeCarrierKey(r.carrier_raw), rawExample: r.carrier_raw });
      }
    }

    if (APPLY && updates.length > 0) {
      for (const u of updates) {
        await db.execute(sql`
          UPDATE phone_lookups SET carrier_norm = ${u.norm}, updated_at = now()
          WHERE phone = ${u.phone}`);
        await db.execute(sql`
          UPDATE contacts SET carrier_norm = ${u.norm}, updated_at = now()
          WHERE phone_number = ${u.phone} AND carrier_norm IS DISTINCT FROM ${u.norm}
            AND carrier_norm <> 'Unidentified'`);
      }
    }
    if (APPLY && triage.length > 0) await enqueueUnresolved(triage);
    process.stdout.write(`  processed ${total} rows (${changed} changed)\r`);
  }

  console.log(`\n\nTotal phone_lookups rows: ${total}. Would change bucket: ${changed}.`);
  printDist("BEFORE (current carrier_norm)", before, total);
  printDist("AFTER (v2 resolver)", after, total);
  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to persist (snapshots first).");
  } else {
    console.log("\nAPPLIED. Rollback source: carrier_norm_backfill_snapshot.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
