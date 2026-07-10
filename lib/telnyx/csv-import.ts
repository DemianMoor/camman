import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { phone_lookups, type NewPhoneLookup } from "@/db/schema";
import { validatePhone } from "@/lib/phone-validation";

import { loadCarrierMappings } from "./carrier-mappings";
import { resolveCarrierNorm } from "./map-carrier";
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
  const mappings = await loadCarrierMappings();

  const values: NewPhoneLookup[] = [];
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
      line_type === "landline" ? "Unknown" : resolveCarrierNorm(carrier_raw, mappings);
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
  const written = await db
    .insert(phone_lookups)
    .values(values)
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

  const writtenPhones = written.map((w) => w.phone);
  const sync =
    writtenPhones.length > 0 ? await syncContactsForPhones(writtenPhones) : { contactsUpdated: 0 };

  return {
    submitted,
    valid: values.length,
    invalid,
    written: writtenPhones.length,
    skipped_telnyx: values.length - writtenPhones.length,
    contacts_synced: sync.contactsUpdated,
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
