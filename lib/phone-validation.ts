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
