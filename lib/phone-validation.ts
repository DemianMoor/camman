import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

// Single source of truth for phone parsing across the project. Future bulk-upload
// flows (contacts, opt-outs, clickers) should reuse this.

export interface PhoneValidationResult {
  valid: boolean;
  normalized: string | null; // E.164, e.g. "+12025550199"
  country_code: string | null; // ISO 3166-1 alpha-2, e.g. "US"
  dial_code: string | null; // e.g. "+1"
  local_number: string | null; // national digits, e.g. "2025550199"
  error?: string;
}

function fail(error: string): PhoneValidationResult {
  return {
    valid: false,
    normalized: null,
    country_code: null,
    dial_code: null,
    local_number: null,
    error,
  };
}

export function validatePhone(
  raw: string,
  defaultCountry: CountryCode = "US",
): PhoneValidationResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fail("Phone number is empty");

  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (!parsed || !parsed.isValid()) return fail("Invalid phone number");

  return {
    valid: true,
    normalized: parsed.number, // E.164
    country_code: parsed.country ?? null,
    dial_code: `+${parsed.countryCallingCode}`,
    local_number: parsed.nationalNumber,
  };
}

// Convenience formatter for display ("+1 202 555 0199"). Falls back to raw E.164
// if the input isn't a parseable phone number.
export function formatPhoneInternational(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}

// Parsed-phone shape (just the success branch of PhoneValidationResult).
export type ParsedPhone = {
  normalized: string;
  country_code: string | null;
  dial_code: string | null;
  local_number: string | null;
};

export type BatchValidationResult = {
  valid: ParsedPhone[];
  invalid: { input: string; error: string }[];
};

// Validate a list of raw phone strings in one pass. Caller is responsible for
// pre-cleaning (trimming/splitting) — empty strings are reported as invalid.
export function validatePhonesBatch(
  rawList: string[],
  defaultCountry: CountryCode = "US",
): BatchValidationResult {
  const valid: ParsedPhone[] = [];
  const invalid: { input: string; error: string }[] = [];
  for (const raw of rawList) {
    const r = validatePhone(raw, defaultCountry);
    if (r.valid && r.normalized) {
      valid.push({
        normalized: r.normalized,
        country_code: r.country_code,
        dial_code: r.dial_code,
        local_number: r.local_number,
      });
    } else {
      invalid.push({ input: raw, error: r.error ?? "Invalid phone number" });
    }
  }
  return { valid, invalid };
}
