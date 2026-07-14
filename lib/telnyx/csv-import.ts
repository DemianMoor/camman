import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { phone_lookups, type NewPhoneLookup } from "@/db/schema";
import { validatePhone } from "@/lib/phone-validation";

import { classifyCarrier } from "../carrier/classify";
import { loadClassifierContext } from "../carrier/classify-context";
import { normalizeCarrierKey } from "../carrier/normalize-key";
import { enqueueUnresolved, type TriageEntry } from "../carrier/triage-queue";
import { mapTelnyxLineType } from "./map-line-type";
import { syncContactsForPhones } from "./sync-contacts";

export interface CsvLookupRow {
  phone: string;
  line_type?: string | null;
  carrier?: string | null;
}

export interface CsvImportResult {
  submitted: number;
  valid: number;
  invalid: number;
  written: number; // phone_lookups rows inserted/updated (csv_import)
  skipped_telnyx: number; // phones with an existing telnyx row (never overwritten)
  contacts_synced: number;
}

// Write predefined line_type/carrier as phone_lookups rows (source='csv_import') and
// sync contacts. Precedence: telnyx overwrites anything; csv_import NEVER overwrites
// an existing telnyx row (setWhere). Garbage line_type coerces to 'unknown' (never
// rejected). A type WITHOUT a carrier lands carrier_norm='Unknown' (looked up,
// undetermined); a landline lands 'Unknown' too (not carrier-segmented). These rows
// are NEVER enqueued — they already carry data (no double spend). Used by both the
// predefined-columns upload path and the bulk-update-existing action.
export async function importCsvLookups(rows: CsvLookupRow[]): Promise<CsvImportResult> {
  const submitted = rows.length;
  const ctx = await loadClassifierContext();

  const values: NewPhoneLookup[] = [];
  const triage: TriageEntry[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const r of rows) {
    const p = validatePhone(r.phone);
    if (!p.valid || !p.normalized) { invalid++; continue; }
    if (seen.has(p.normalized)) continue; // same-file dedupe
    seen.add(p.normalized);

    const line_type = mapTelnyxLineType(r.line_type);
    const carrier_raw = r.carrier?.trim() || null;
    const carrier_norm =
      line_type === "landline"
        ? "Unknown"
        : classifyCarrier({ carrierName: carrier_raw }, ctx).carrier_norm;
    if (ctx.v2 && carrier_norm === "Unmapped" && carrier_raw) {
      triage.push({ matchKey: normalizeCarrierKey(carrier_raw), rawExample: carrier_raw });
    }
    values.push({
      phone: p.normalized,
      line_type,
      carrier_raw,
      carrier_norm,
      source: "csv_import",
      lookup_status: "complete",
    });
  }

  if (values.length === 0) {
    return { submitted, valid: 0, invalid, written: 0, skipped_telnyx: 0, contacts_synced: 0 };
  }

  // Upsert, but NEVER overwrite a telnyx row (setWhere). New phones insert;
  // existing csv_import rows update; existing telnyx rows are left untouched.
  //
  // CHUNKED: a single INSERT with every row blows Postgres's 65,535-bind-parameter
  // limit at scale (drizzle binds ~13 columns/row, so ~5K rows is the ceiling; a
  // 36K-row upload was ~470K params → 500). Chunk well under it. The upsert is
  // idempotent, so per-batch commits are safe to re-run.
  const CHUNK = 3000;
  const writtenPhones: string[] = [];
  for (let i = 0; i < values.length; i += CHUNK) {
    const written = await db
      .insert(phone_lookups)
      .values(values.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: phone_lookups.phone,
        set: {
          line_type: sql`excluded.line_type`,
          carrier_raw: sql`excluded.carrier_raw`,
          carrier_norm: sql`excluded.carrier_norm`,
          source: sql`'csv_import'`,
          lookup_status: sql`'complete'`,
          looked_up_at: sql`now()`,
          updated_at: sql`now()`,
        },
        setWhere: sql`${phone_lookups.source} <> 'telnyx'`,
      })
      .returning({ phone: phone_lookups.phone });
    for (const w of written) writtenPhones.push(w.phone);
  }

  // Sync contacts in the same chunk size (bounds each UPDATE's ANY(array) literal).
  let contactsUpdated = 0;
  for (let i = 0; i < writtenPhones.length; i += CHUNK) {
    const sync = await syncContactsForPhones(writtenPhones.slice(i, i + CHUNK));
    contactsUpdated += sync.contactsUpdated;
  }

  // Unmapped carrier strings from this import -> AI triage (same queue as the
  // automated path). enqueueUnresolved dedups internally (distinct carrier strings
  // are few), so the array literal stays small even for a large upload.
  if (triage.length > 0) await enqueueUnresolved(triage);

  return {
    submitted,
    valid: values.length,
    invalid,
    written: writtenPhones.length,
    skipped_telnyx: values.length - writtenPhones.length,
    contacts_synced: contactsUpdated,
  };
}

// Which of the given (already-normalized) phones already have predefined data in
// this batch — used by the upload path to EXCLUDE predefined rows from the lookup
// enqueue (no double spend even with the toggle ON).
export function predefinedPhonesOf(rows: CsvLookupRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.line_type && !r.carrier) continue;
    const p = validatePhone(r.phone);
    if (p.valid && p.normalized) out.add(p.normalized);
  }
  return out;
}
