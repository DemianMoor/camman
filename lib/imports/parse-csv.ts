import "server-only";

import Papa from "papaparse";
import { parsePhoneNumberFromString } from "libphonenumber-js";

import type { MappingColumns } from "./canonical-fields";
import type { ParsedRow } from "./outcome";

export const CSV_MAX_BYTES = 25 * 1024 * 1024; // 25 MB hard cap

// Read a single cell from a row, trimming whitespace; returns null when the
// column isn't present in the mapping OR the cell is empty.
function readCell(
  raw: Record<string, string>,
  column: string | undefined,
): string | null {
  if (!column) return null;
  const v = raw[column];
  if (v == null) return null;
  const t = String(v).trim();
  return t.length === 0 ? null : t;
}

// Parse a CSV string into ParsedRow[]. Header-driven (first row is the header
// names that the mapping references). Phone numbers are validated via
// libphonenumber and normalized to E.164; rows with unparseable phones get
// phone_number=null so the caller can bucket them as invalid.
//
// Note: PapaParse's chunk mode is for streaming Files in the browser; in
// Node we already have the full text in memory by this point (capped at
// CSV_MAX_BYTES), so we use the synchronous parse and walk results.
export function parseCsv(
  csvContent: string,
  columns: MappingColumns,
): { rows: ParsedRow[]; submitted: number; headerColumns: string[] } {
  const parsed = Papa.parse<Record<string, string>>(csvContent, {
    header: true,
    skipEmptyLines: "greedy",
    // Don't transform field names — we match against whatever the provider sent.
    transformHeader: (h) => h.trim(),
  });

  const headerColumns = parsed.meta.fields ?? [];
  const out: ParsedRow[] = [];

  for (const raw of parsed.data) {
    if (!raw || typeof raw !== "object") continue;
    const phoneRaw = readCell(raw, columns.phone_number);
    let normalized: string | null = null;
    if (phoneRaw) {
      const p = parsePhoneNumberFromString(phoneRaw, "US");
      if (p && p.isValid()) {
        normalized = p.number; // E.164
      }
    }

    const costRaw = readCell(raw, columns.cost);
    const costNum = costRaw != null ? Number(costRaw) : null;

    out.push({
      phone_number: normalized,
      status_raw: readCell(raw, columns.status),
      is_optout_raw: readCell(raw, columns.is_optout),
      is_clicker_raw: readCell(raw, columns.is_clicker),
      cost: costNum != null && Number.isFinite(costNum) ? costNum : null,
      raw,
    });
  }

  return {
    rows: out,
    submitted: parsed.data.length,
    headerColumns,
  };
}
