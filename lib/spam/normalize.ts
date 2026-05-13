import { createHash } from "node:crypto";

// Canonicalize SMS text for hashing + classification. Must produce the EXACT
// same hash as the Python classifier service's `normalize_text`:
//   1. NFKC unicode normalization (collapses ligatures, fullwidth → ASCII, etc.)
//   2. Lowercase
//   3. Trim leading/trailing whitespace
//   4. Collapse runs of whitespace (spaces, tabs, newlines) into single spaces
// SHA-256 over UTF-8 bytes of the result.
//
// Keep this in sync with the canonical reference in the Python classifier
// project: src/data/normalize.py. Any divergence makes the cache miss across
// the boundary, which silently doubles cost.

export function normalizeText(text: string): string {
  // \s matches all Unicode whitespace including tabs and newlines.
  return text.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

export function hashText(text: string): string {
  const normalized = normalizeText(text);
  return createHash("sha256").update(normalized, "utf-8").digest("hex");
}
