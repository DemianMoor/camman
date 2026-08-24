// Partner lead field definitions — Drip Phase 2.
//
// ⭐ THIS IS THE SINGLE SOURCE for three things that must never disagree:
//   1. what the intake endpoint accepts,
//   2. what a partner key's field_mapping may target,
//   3. what the generated partner instructions document says.
//
// Risk R19 is precisely that the doc drifts from the validator. The same map
// drives both, so a field added here appears in the doc automatically — the
// same discipline RULE_TYPES uses as the one source for server and client in
// the segment-rules system.
//
// Phase 2 does NOT normalize anything except the phone (which the dedup key and
// the phone_e164 column need). Everything else is captured verbatim into
// lead_inbox.raw and normalized by Phase 3's enrichment worker. `type` below is
// therefore documentation for the partner, not a coercion instruction.

// Ruling G13: a batch larger than this is refused whole, with the max in the
// body. Lives here rather than in the route because the generated partner doc
// quotes it — one constant, so the doc cannot promise a different number than
// the endpoint enforces.
export const MAX_LEADS_PER_CALL = 500;

export type LeadFieldType = "phone" | "string" | "email" | "date" | "boolean" | "enum";

export interface LeadFieldDef {
  /** Canonical name — matches the contact_attributes column it will land in. */
  key: string;
  label: string;
  type: LeadFieldType;
  required: boolean;
  /** Aliases accepted verbatim, before any per-partner field_mapping. */
  aliases: string[];
  /** Shown in the partner doc. */
  example: string;
  notes?: string;
  allowed?: string[];
}

export const LEAD_FIELDS: LeadFieldDef[] = [
  {
    key: "phone",
    label: "Mobile Number",
    type: "phone",
    required: true,
    aliases: ["mobile", "mobile_number", "phone_number", "cell", "telephone", "msisdn"],
    example: "+12025550199",
    notes:
      "The only required field. E.164 is preferred; US national format is accepted " +
      "and normalized. A number that cannot be parsed is stored with status " +
      "'rejected' rather than discarded.",
  },
  {
    key: "interest_tag",
    label: "Interest Tag",
    type: "string",
    required: false,
    aliases: ["tag", "interest", "vertical"],
    example: "ACA",
    notes:
      "May be overridden or defaulted by key configuration. Not a fixed list; " +
      "new tags are added as configuration.",
  },
  { key: "first_name", label: "First Name", type: "string", required: false,
    aliases: ["fname", "firstname", "given_name"], example: "Jane" },
  { key: "last_name", label: "Last Name", type: "string", required: false,
    aliases: ["lname", "lastname", "surname", "family_name"], example: "Doe" },
  { key: "email", label: "Email", type: "email", required: false,
    aliases: ["email_address", "mail"], example: "jane@example.com",
    notes: "Stored lowercased and trimmed. Not a unique key; the phone number is the identity." },
  { key: "address", label: "Address", type: "string", required: false,
    aliases: ["street", "address1", "address_line_1"], example: "123 Main St" },
  { key: "state", label: "State", type: "string", required: false,
    aliases: ["st", "region", "province"], example: "TX" },
  { key: "country", label: "Country", type: "string", required: false,
    aliases: ["country_code"], example: "US" },
  { key: "gender", label: "Gender", type: "enum", required: false,
    aliases: ["sex"], example: "female", allowed: ["male", "female", "other"] },
  {
    key: "dob", label: "Date of Birth", type: "date", required: false,
    aliases: ["date_of_birth", "birth_date", "birthday"], example: "1985-04-17",
    notes:
      "ISO 8601 (YYYY-MM-DD). Omit or send an empty value when unknown. Epoch " +
      "placeholders such as 1970-01-01 are treated as unknown and discarded.",
  },
  {
    key: "income_band", label: "Income", type: "enum", required: false,
    aliases: ["income", "household_income"], example: "50-75k",
    allowed: ["<25k", "25-50k", "50-75k", "75-100k", "100-150k", "150k+"],
  },
  { key: "kids", label: "Has Children", type: "boolean", required: false,
    aliases: ["children", "has_kids"], example: "true" },
  { key: "married", label: "Married", type: "boolean", required: false,
    aliases: ["is_married", "marital_status"], example: "false" },
];

export const REQUIRED_FIELD_KEYS = LEAD_FIELDS.filter((f) => f.required).map((f) => f.key);
export const LEAD_FIELD_KEYS = LEAD_FIELDS.map((f) => f.key);

/** Canonical key for an incoming field name, or null if it is not one of ours. */
export function canonicalFieldKey(
  incoming: string,
  mapping: Record<string, string> = {},
): string | null {
  const raw = incoming.trim();
  const lower = raw.toLowerCase();

  // The partner key's explicit mapping wins over every built-in alias — that is
  // what it is for. Checked case-insensitively so a partner sending "Zip_Code"
  // matches a mapping written as "zip_code".
  for (const [from, to] of Object.entries(mapping)) {
    if (from.toLowerCase() === lower && LEAD_FIELD_KEYS.includes(to)) return to;
  }

  const norm = lower.replace(/[\s-]+/g, "_");
  for (const f of LEAD_FIELDS) {
    if (f.key === norm) return f.key;
    if (f.aliases.includes(norm)) return f.key;
  }
  return null;
}

/**
 * Pull the canonical fields out of one partner payload.
 *
 * Unknown keys are NOT dropped — the whole payload is stored in `lead_inbox.raw`
 * regardless. This only extracts what Phase 2 needs to address a row (phone for
 * the dedup key, interest_tag for routing). Everything else waits for Phase 3.
 */
export function extractLeadFields(
  payload: Record<string, unknown>,
  mapping: Record<string, string> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    const key = canonicalFieldKey(k, mapping);
    // First match wins: a payload carrying both "mobile" and "phone" should not
    // have its real value silently replaced by a later empty alias.
    if (key && out[key] === undefined && v !== null && v !== "") out[key] = v;
  }
  return out;
}
