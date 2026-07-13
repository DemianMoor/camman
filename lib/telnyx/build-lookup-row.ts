import type { NewPhoneLookup } from "@/db/schema";

import { classifyCarrier, type ClassifierContext } from "../carrier/classify";
import { resolveLineType } from "./map-line-type";
import type { TelnyxNumberLookupData } from "./types";

// Telnyx's network-normalized carrier name, read defensively from both observed
// paths (carrier.normalized_carrier, then top-level). Returns null when absent —
// Telnyx populates it on only ~39% of rows, so the resolver treats absence as
// "skip step 1 and fall through to the raw carrier_name layers".
export function extractTelnyxNormalized(
  data: TelnyxNumberLookupData,
): string | null {
  const v =
    data.carrier?.normalized_carrier?.trim() ||
    data.normalized_carrier?.trim() ||
    "";
  return v || null;
}

// Pure transform: Telnyx lookup payload + classifier context -> a phone_lookups row.
// `phone` MUST already be normalized E.164 (+1XXXXXXXXXX) by the caller so the PK
// matches contacts.phone_number. source is always 'telnyx' here (the live lookup).
//
// Returns the row plus the resolver source and the normalized key of an unresolved
// carrier string, so the worker can enqueue it for AI triage (§ the shared chain
// resolves to 'Unmapped' but does not itself write the queue).
export function buildLookupRowFromTelnyx(
  phone: string,
  data: TelnyxNumberLookupData,
  ctx: ClassifierContext,
): NewPhoneLookup {
  const line_type = resolveLineType(data);
  const carrier_raw = data.carrier?.name?.trim() || null;
  const normalized_carrier = extractTelnyxNormalized(data);

  // Landlines are suppressed (not_applicable) and never carrier-segmented, so we
  // don't bucket their carrier — that would flood the admin unmapped queue with
  // hundreds of landline-carrier strings that never need a mapping. carrier_raw is
  // still kept for audit.
  const carrier_norm =
    line_type === "landline"
      ? "Unknown"
      : classifyCarrier({ telnyxNormalized: normalized_carrier, carrierName: carrier_raw }, ctx)
          .carrier_norm;

  const port = data.portability ?? null;
  const ported_status = port?.ported_status?.trim();

  return {
    phone,
    line_type,
    carrier_raw,
    carrier_norm,
    normalized_carrier,
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
