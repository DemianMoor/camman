// Demographic filter vocabularies for drip campaigns.
//
// ⚠️ PURE ON PURPOSE — no drizzle, no server imports. The campaign editor is a
// client component and needs these lists; importing them from the validator
// would pull the query builder into the browser bundle, and re-typing them in
// the UI would let the dropdown offer a value routing does not accept.
// One definition, imported by both sides.

export const GENDERS = ["male", "female", "other"] as const;
export const AGE_BANDS = ["18_24", "25_34", "35_44", "45_54", "55_64", "65_plus"] as const;
export const INCOME_BANDS = [
  "lt_25k",
  "25k_50k",
  "50k_75k",
  "75k_100k",
  "100k_150k",
  "gte_150k",
] as const;

/** Human-readable form of a band code, for the picker. */
export function bandLabel(v: string): string {
  return v
    .replace(/^lt_/, "< ")
    .replace(/^gte_/, "≥ ")
    .replace(/_plus$/, "+")
    .replace(/_/g, "–")
    .replace(/k/g, "k");
}
