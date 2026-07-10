import type { LineType, TelnyxNumberLookupData } from "./types";

// Telnyx carrier.type / portability.line_type -> our LineType.
//
// Telnyx uses Google libphonenumber's PhoneNumberType strings, which have NO
// 'landline' value ('fixed line' is the landline case). We prefer
// portability.line_type (port-corrected) then fall back to carrier.type.
// Anything exotic or ambiguous ('fixed line or mobile', 'premium rate', pagers,
// etc.) maps to 'unknown', which stays messaging_status='eligible' — conservative,
// we never silently suppress a number we're unsure about.
export function mapTelnyxLineType(raw: string | null | undefined): LineType {
  if (!raw) return "unknown";
  const v = raw.trim().toLowerCase();
  switch (v) {
    case "mobile":
      return "mobile";
    case "fixed line":
    case "landline":
    case "fixed":
      return "landline";
    case "voip":
    case "voice over ip":
      return "voip";
    case "toll free":
    case "toll-free":
    case "tollfree":
      return "toll_free";
    // 'fixed line or mobile', 'premium rate', 'shared cost', 'personal number',
    // 'pager', 'uan', 'voicemail', 'unknown', and any unrecognized string:
    default:
      return "unknown";
  }
}

// Resolve a lookup payload to our LineType: portability.line_type wins (it is
// port-corrected), else carrier.type.
export function resolveLineType(data: TelnyxNumberLookupData): LineType {
  const ported = data.portability?.line_type;
  if (ported && ported.trim()) return mapTelnyxLineType(ported);
  return mapTelnyxLineType(data.carrier?.type);
}
