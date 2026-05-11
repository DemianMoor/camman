// Validator helpers shared across entity schemas. Keep this file dependency-free
// so it can be imported by any validator file without cycles.

// Empty strings from form inputs (HTML <input> default value is "") should map
// to NULL in the DB. Used by API routes after Zod parsing, before insert/update.
export function nullIfEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
