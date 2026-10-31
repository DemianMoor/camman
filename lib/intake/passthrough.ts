// Partner passthrough fields — pure extraction + whitelist validation.
//
// A partner key carries a whitelist (`partner_keys.passthrough_fields`) of extra
// per-lead field names to keep verbatim (e.g. their own list_id). Everything
// else the partner sends stays only in lead_inbox.raw. No DB access here.

import { canonicalFieldKey } from "./fields";

export const PASSTHROUGH_LIMITS = {
  maxFields: 10,
  maxNameLength: 40,
  maxValueLength: 256,
  maxTotalBytes: 2048,
} as const;

export const PASSTHROUGH_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Placeholder names the postback template engine fills itself. */
export const SYSTEM_PLACEHOLDERS = [
  "status",
  "event",
  "conversion_id",
  "occurred_at",
  "currency",
  "payout",
] as const;

/** Validation error for a whitelist of passthrough names, or null when valid. */
export function passthroughNamesError(names: string[]): string | null {
  if (names.length > PASSTHROUGH_LIMITS.maxFields) {
    return `At most ${PASSTHROUGH_LIMITS.maxFields} passthrough fields`;
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (!PASSTHROUGH_NAME_RE.test(name)) {
      return `${name} is not a valid field name (lowercase letters, digits and underscores, starting with a letter, max ${PASSTHROUGH_LIMITS.maxNameLength} characters)`;
    }
    if (canonicalFieldKey(name) !== null) return `${name} is already a built-in field`;
    if ((SYSTEM_PLACEHOLDERS as readonly string[]).includes(name)) {
      return `${name} is a reserved placeholder name`;
    }
    if (seen.has(name)) return `${name} is listed more than once`;
    seen.add(name);
  }
  return null;
}

/**
 * Pick the whitelisted fields out of one partner payload. Keys match a name when
 * `key.trim().toLowerCase() === name`; first non-empty match wins (same rule as
 * `extractLeadFields`). Values are stringified scalars; invalid or oversize
 * values are dropped with a warning, never failing the lead.
 */
export function extractPassthrough(
  raw: Record<string, unknown>,
  names: readonly string[],
): { data: Record<string, string> | null; warnings: string[] } {
  const data: Record<string, string> = {};
  const warnings: string[] = [];
  const entries = Object.entries(raw);
  let overBudget = false;

  for (const name of names) {
    let value: unknown;
    for (const [k, v] of entries) {
      if (k.trim().toLowerCase() === name && v !== null && v !== undefined && v !== "") {
        value = v;
        break;
      }
    }
    if (value === undefined) continue;

    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      warnings.push(`${name}: value must be a string, number or boolean`);
      continue;
    }
    const str = String(value);
    if (str.length > PASSTHROUGH_LIMITS.maxValueLength) {
      warnings.push(`${name}: value longer than ${PASSTHROUGH_LIMITS.maxValueLength} characters`);
      continue;
    }
    // Once one field overflows, every later present field is dropped too, so the
    // kept set is always a whitelist-order prefix.
    if (
      overBudget ||
      Buffer.byteLength(JSON.stringify({ ...data, [name]: str })) > PASSTHROUGH_LIMITS.maxTotalBytes
    ) {
      overBudget = true;
      warnings.push(`${name}: dropped, partner data over ${PASSTHROUGH_LIMITS.maxTotalBytes} bytes`);
      continue;
    }
    data[name] = str;
  }

  return { data: Object.keys(data).length > 0 ? data : null, warnings };
}
