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
import { createRequire } from "node:module";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
// Neutralize the `server-only` guard for this tsx run BEFORE any server-only module
// loads (same shim as scripts/run-lookup-calibration.ts). The server-only modules
// are dynamic-imported inside main() so they resolve after this stub is in place.
const req = createRequire(import.meta.url);
try {
  const p = req.resolve("server-only");
  // @ts-expect-error minimal Module cache entry
  req.cache[p] = { id: p, filename: p, loaded: true, exports: {} };
} catch {
  /* noop */
}

import { sql } from "drizzle-orm";

import type { TriageEntry } from "@/lib/carrier/triage-queue";
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
  // Dynamic imports so the server-only stub (top of file) is in place first.
  const { db } = await import("@/db/client");
  const { classifyCarrier } = await import("@/lib/carrier/classify");
  const { loadClassifierContext } = await import("@/lib/carrier/classify-context");
  const { normalizeCarrierKey } = await import("@/lib/carrier/normalize-key");
  const { enqueueUnresolved } = await import("@/lib/carrier/triage-queue");
  const { extractTelnyxNormalized } = await import("@/lib/telnyx/build-lookup-row");

  const ctx = await loadClassifierContext(true); // preview/apply always use v2 semantics

  if (APPLY) {
    // (1) normalized_carrier from raw_response — free, idempotent. RETURNING so the
    // count is the rows ACTUALLY updated (a bare UPDATE returns no rows → logs 0).
    const nc = await db.execute(sql`
      UPDATE phone_lookups
      SET normalized_carrier = COALESCE(
        NULLIF(TRIM(raw_response->'carrier'->>'normalized_carrier'), ''),
        NULLIF(TRIM(raw_response->>'normalized_carrier'), '')
      )
      WHERE normalized_carrier IS NULL AND raw_response IS NOT NULL
      RETURNING phone`);
    console.log(`normalized_carrier backfilled on ${nc.length} rows (from raw_response)`);

    // (2) rollback snapshot of contacts.carrier_norm (only once).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS carrier_norm_backfill_snapshot (
        contact_id uuid PRIMARY KEY,
        carrier_norm text NOT NULL,
        snapped_at timestamptz NOT NULL DEFAULT now()
      )`);
    await db.execute(sql`
      INSERT INTO carrier_norm_backfill_snapshot (contact_id, carrier_norm)
      SELECT id, carrier_norm FROM contacts
      ON CONFLICT (contact_id) DO NOTHING`);
    // Total snapshot size (idempotent: a re-run adds nothing) — the rollback source.
    const snap = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM carrier_norm_backfill_snapshot`);
    console.log(`carrier_norm_backfill_snapshot total rows: ${snap[0]?.n ?? 0} (rollback source)`);
  }

  const before = new Map<string, number>();
  const after = new Map<string, number>();
  const sources = new Map<string, number>(); // resolver source breakdown (non-landline)
  let changed = 0;
  let total = 0;
  let landline = 0;
  let normPresent = 0; // rows with a non-empty normalized_carrier in raw_response
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
      const tn = r.raw_response ? extractTelnyxNormalized(r.raw_response) : null;
      if (tn) normPresent++;
      let newNorm: CarrierNorm;
      if (r.line_type === "landline") {
        newNorm = "Unknown";
        landline++;
      } else {
        const res = classifyCarrier({ telnyxNormalized: tn, carrierName: r.carrier_raw }, ctx);
        newNorm = res.carrier_norm;
        tallyRow(sources, res.source);
      }
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
  const pct = (n: number) => (total ? ((n / total) * 100).toFixed(1) : "0.0");
  console.log(
    `Landline rows (skip carrier classify, forced Unknown): ${landline} (${pct(landline)}%)`,
  );
  console.log(
    `\nTelnyx normalized_carrier PRESENT in raw_response: ${normPresent} (${pct(normPresent)}%)` +
      `  ← JSON-path check vs ~39.3% baseline`,
  );
  printDist("RESOLVER SOURCE (non-landline rows)", sources, total - landline);
  const telnyxNorm = sources.get("telnyx_norm") ?? 0;
  console.log(
    `\n(b) Resolved by STEP 1 (source=telnyx_norm): ${telnyxNorm} = ${pct(telnyxNorm)}% of all rows, ` +
      `${total - landline ? ((telnyxNorm / (total - landline)) * 100).toFixed(1) : "0.0"}% of non-landline`,
  );
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
