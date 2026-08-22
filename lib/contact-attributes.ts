import {
  AGE_BAND_BOUNDS,
  AGE_BAND_VALUES,
  GENDER_VALUES,
  INCOME_BAND_VALUES,
  type AgeBandValue,
} from "@/lib/validators/segment-rule-types";

// Pure helpers for contact_attributes (migration 0147). NO db / server imports —
// the contact detail page, the CSV import preview and the API all read from the
// same functions so a displayed age can never disagree with a targeted one.
//
// ⚠️ AGE IS DERIVED, NEVER STORED. There is no `age` column and there must not
// be one: it is wrong the day after it is written. The segment rule does the
// same derivation in SQL as a dob RANGE (see ageBandClause in
// lib/segment-rules-eval.ts); this is the read-side twin of that arithmetic and
// the two must agree.

/** Field labels for the detail page and the CSV mapping picker. */
export const ATTRIBUTE_FIELDS = [
  { field: "first_name", label: "First name" },
  { field: "last_name", label: "Last name" },
  { field: "email", label: "Email" },
  { field: "address", label: "Address" },
  { field: "state", label: "State" },
  { field: "country", label: "Country" },
  { field: "gender", label: "Gender" },
  { field: "dob", label: "Date of birth" },
  { field: "income_band", label: "Income band" },
  { field: "kids", label: "Has kids" },
  { field: "married", label: "Married" },
  { field: "interest_tag", label: "Interest tag" },
  { field: "partner_slug", label: "Partner" },
] as const;

export type AttributeField = (typeof ATTRIBUTE_FIELDS)[number]["field"];
export const ATTRIBUTE_FIELD_KEYS = ATTRIBUTE_FIELDS.map((f) => f.field);

export const AGE_BAND_LABELS: Record<AgeBandValue, string> = {
  "18_24": "18–24",
  "25_34": "25–34",
  "35_44": "35–44",
  "45_54": "45–54",
  "55_64": "55–64",
  "65_plus": "65+",
};

export const INCOME_BAND_LABELS: Record<string, string> = {
  lt_25k: "Under $25k",
  "25k_50k": "$25k–50k",
  "50k_75k": "$50k–75k",
  "75k_100k": "$75k–100k",
  "100k_150k": "$100k–150k",
  gte_150k: "$150k+",
};

// The ET calendar date, matching the send path and the age_band rule's SQL.
// Using the browser/server local date here would put the displayed band a day
// out of step with the targeted one for a few hours each night.
function etToday(now: Date = new Date()): Date {
  const s = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function parseDob(dob: string | Date): Date | null {
  const s = typeof dob === "string" ? dob.slice(0, 10) : dob.toISOString().slice(0, 10);
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

/** Whole years as of the ET calendar date. Null for an unparseable dob. */
export function ageFromDob(dob: string | Date, now?: Date): number | null {
  const b = parseDob(dob);
  if (!b) return null;
  const t = etToday(now);
  let age = t.getUTCFullYear() - b.getUTCFullYear();
  const beforeBirthday =
    t.getUTCMonth() < b.getUTCMonth() ||
    (t.getUTCMonth() === b.getUTCMonth() && t.getUTCDate() < b.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/**
 * The band a dob falls in, or null.
 *
 * ⚠️ Returns null for anyone UNDER 18 — there is no under-18 band, and this
 * must keep returning null rather than inventing one, so a minor can never be
 * displayed as belonging to a targetable cohort. Mirrors the hard 18-year floor
 * the age_band rule applies in SQL.
 */
export function ageBandFromDob(dob: string | Date, now?: Date): AgeBandValue | null {
  const age = ageFromDob(dob, now);
  if (age === null || age < 18) return null;
  for (const band of AGE_BAND_VALUES) {
    const { minAge, maxAge } = AGE_BAND_BOUNDS[band];
    if (age >= minAge && (maxAge === null || age <= maxAge)) return band;
  }
  return null;
}

// ── CSV value normalization ─────────────────────────────────────────────────
//
// Applied at the write boundary for BOTH the CSV import and (later) drip
// intake, so the two cannot disagree about what a blank means.

/** The epoch-as-blank artefact and its friends. */
const BLANK_DOBS = new Set(["1970-01-01", "0000-00-00", "0001-01-01"]);

/**
 * Normalize a CSV date cell to `YYYY-MM-DD`, or null.
 *
 * ⚠️ `1970-01-01` becomes NULL. Spreadsheet exports emit the epoch for a blank
 * date, and the DB CHECK cannot reject it — 1970-01-01 is a legitimate
 * birthdate. Storing it would manufacture a 56-year-old cohort out of empty
 * cells, and if a global minor gate is ever added, mistyped blanks become the
 * difference between messaging someone and not. This function is the ONLY thing
 * that closes that case.
 */
export function normalizeDob(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  let iso: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) iso = v.slice(0, 10);
  else {
    // M/D/YYYY and D/M/YYYY are ambiguous; we accept the US form only, because
    // guessing silently would corrupt a birthday rather than reject it.
    const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const [, mo, da, yr] = m;
      iso = `${yr}-${mo.padStart(2, "0")}-${da.padStart(2, "0")}`;
    }
  }
  if (!iso || BLANK_DOBS.has(iso)) return null;
  const d = parseDob(iso);
  if (!d || Number.isNaN(d.getTime())) return null;
  // Mirrors the DB CHECK so a bad row is reported at preview instead of
  // exploding on insert.
  if (iso <= "1900-01-01") return null;
  if (d > etToday()) return null;
  return iso;
}

/** Email: lowercase + trim. No uniqueness — phone is the identity. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  return v.length > 0 ? v : null;
}

const TRUTHY = new Set(["yes", "y", "true", "1", "t"]);
const FALSY = new Set(["no", "n", "false", "0", "f"]);

/** Tri-state: true / false / null (unknown). Anything unrecognized is null. */
export function normalizeBool(raw: string | null | undefined): boolean | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return null;
}

/** Map free-text income to a coded band, or null. */
export function normalizeIncomeBand(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase().replace(/[\s,$]/g, "");
  if (!v) return null;
  if ((INCOME_BAND_VALUES as readonly string[]).includes(v)) return v;
  const alias: Record<string, string> = {
    "<25k": "lt_25k", "under25k": "lt_25k", "0-25k": "lt_25k",
    "25-50k": "25k_50k", "25k-50k": "25k_50k",
    "50-75k": "50k_75k", "50k-75k": "50k_75k",
    "75-100k": "75k_100k", "75k-100k": "75k_100k",
    "100-150k": "100k_150k", "100k-150k": "100k_150k",
    "150k+": "gte_150k", "over150k": "gte_150k", ">150k": "gte_150k",
  };
  return alias[v] ?? null;
}

/** Map free-text gender to the closed set, or null. */
export function normalizeGender(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if ((GENDER_VALUES as readonly string[]).includes(v)) return v;
  if (v === "m" || v === "man") return "male";
  if (v === "f" || v === "w" || v === "woman") return "female";
  if (v === "o" || v === "nonbinary" || v === "non-binary") return "other";
  return null;
}

/** Normalize one CSV cell for the given attribute field. */
export function normalizeAttributeValue(
  field: AttributeField,
  raw: string | null | undefined,
): string | boolean | null {
  switch (field) {
    case "dob":
      return normalizeDob(raw);
    case "email":
      return normalizeEmail(raw);
    case "kids":
    case "married":
      return normalizeBool(raw);
    case "income_band":
      return normalizeIncomeBand(raw);
    case "gender":
      return normalizeGender(raw);
    default: {
      const v = (raw ?? "").trim();
      return v.length > 0 ? v : null;
    }
  }
}
