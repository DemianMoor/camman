// Telnyx Number Lookup — shared types. Field names verified against the current
// telnyx-node SDK source (= Telnyx's live OpenAPI spec). See docs/06-integrations.md.

// Our internal line-type buckets (contacts.line_type / phone_lookups.line_type).
export type LineType = "mobile" | "landline" | "voip" | "toll_free" | "unknown";

// Our six carrier buckets + two non-bucket states:
//   'Unmapped'     — looked up, raw carrier string awaiting an admin mapping.
//                    Groups with 'Unknown' in filters; only the queue tracks it.
//   'Unidentified' — CONTACTS ONLY: no phone_lookups row exists for the phone
//                    (never looked up). NEVER written to phone_lookups (0095 CHECK)
//                    nor produced by resolveCarrierNorm — it's a contacts default.
export type CarrierNorm =
  | "AT&T"
  | "T-Mobile"
  | "Verizon"
  | "Other Mobile"
  | "VoIP"
  | "Unknown"
  | "Unmapped"
  | "Unidentified";

// Raw shape of GET /v2/number_lookup/{+E164}?type=carrier (the fields we read).
export interface TelnyxNumberLookupData {
  record_type?: string;
  phone_number?: string;
  national_format?: string;
  country_code?: string;
  carrier?: {
    name?: string | null;
    // libphonenumber's PhoneNumberType enum — NOTE: no 'landline' value.
    type?: string | null;
    mobile_country_code?: string | null;
    mobile_network_code?: string | number | null;
    error_code?: string | null;
  } | null;
  portability?: {
    lrn?: string | null;
    ocn?: string | null;
    spid?: string | null;
    ported_status?: string | null; // 'Y' | 'N' | ''
    ported_date?: string | null; // 'YYYY-MM-DD'
    line_type?: string | null; // port-corrected line type — preferred over carrier.type
  } | null;
}

export interface TelnyxNumberLookupResponse {
  data: TelnyxNumberLookupData;
}

// GET /v2/balance — all fields are STRINGS in the API.
export interface TelnyxBalanceResponse {
  data: {
    balance?: string;
    available_credit?: string;
    credit_limit?: string;
    currency?: string;
    pending?: string;
    record_type?: string;
  };
}

// Normalized result our worker consumes — the client never throws; on failure it
// returns { ok: false }. On success, `data` is the raw payload for the caller to
// map + store (raw_response audit).
export type TelnyxLookupResult =
  | { ok: true; data: TelnyxNumberLookupData }
  | { ok: false; status: number | null; error: string; retryable: boolean };

export type TelnyxBalanceResult =
  | { ok: true; availableCredit: number; balance: number; currency: string }
  | { ok: false; status: number | null; error: string };
