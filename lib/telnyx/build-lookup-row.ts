import type { NewPhoneLookup } from "@/db/schema";

import { resolveLineType } from "./map-line-type";
import { resolveCarrierNorm } from "./map-carrier";
import type { CarrierNorm, TelnyxNumberLookupData } from "./types";

// Pure transform: Telnyx lookup payload + carrier mappings -> a phone_lookups row.
// `phone` MUST already be normalized E.164 (+1XXXXXXXXXX) by the caller so the PK
// matches contacts.phone_number. source is always 'telnyx' here (this path is the
// live lookup); CSV import builds rows with source='csv_import' elsewhere.
export function buildLookupRowFromTelnyx(
  phone: string,
  data: TelnyxNumberLookupData,
  mappings: Map<string, CarrierNorm>,
): NewPhoneLookup {
  const line_type = resolveLineType(data);
  const carrier_raw = data.carrier?.name?.trim() || null;
  // Landlines are suppressed (not_applicable) and never carrier-segmented, so we
  // don't bucket their carrier — that would flood the admin unmapped queue with
  // hundreds of landline-carrier strings that never need a mapping. carrier_raw is
  // still kept for audit.
  const carrier_norm =
    line_type === "landline"
      ? "Unknown"
      : resolveCarrierNorm(carrier_raw, mappings);
  const port = data.portability ?? null;
  const ported_status = port?.ported_status?.trim();

  return {
    phone,
    line_type,
    carrier_raw,
    carrier_norm,
    ocn: port?.ocn?.trim() || null,
    spid: port?.spid?.trim() || null,
    ported:
      ported_status === "Y" ? true : ported_status === "N" ? false : null,
    ported_date: port?.ported_date?.trim() || null,
    source: "telnyx",
    lookup_status: "complete",
    raw_response: data as unknown as NewPhoneLookup["raw_response"],
  };
}
