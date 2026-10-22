// Personalization tag REGISTRY — the single source for which tags exist, how a
// raw value is normalized, what counts as missing, and each tag's worst-case
// length. PURE and CLIENT-SAFE (no DB / server imports): the creative editor,
// the stage form preview, every send path and the SQL twins (tag-sql.ts) all
// read from here, so an editor's worst case, a preview's skip count and a
// recipient's body can never disagree.
//
// Adding a tag = one entry in TAGS (+ its column in the SQL twin map if it is a
// contact field). Tag syntax is an EXACT lowercase `{key}`; any other brace
// token is literal text — live creative 637 ships "{FirstName}" verbatim.
//
// Spec: docs/superpowers/specs/2026-10-19-message-personalization-formats-design.md §A.

export type TagKey = "first_name" | "zip" | "state" | "brand";

/** The format-template blocks (spec B2). Owned here so tag scanning can tell a
 *  block token from an unknown one without importing format.ts. */
export const BLOCK_KEYS = ["brand", "creative_text", "url", "stop_text"] as const;

export interface RecipientData {
  first_name: string | null;
  zip: string | null;
  state: string | null;
}

/** No contact data: a message without tags renders the same for everyone. */
export const NO_RECIPIENT: RecipientData = { first_name: null, zip: null, state: null };

export interface TagDef {
  key: TagKey;
  label: string;
  scope: "contact" | "campaign";
  maxLength: number;
  /** Stand-in used for worst-case length (creative editor, segment threshold). */
  worstCase: string;
  /** Normalized value, or null when the value is MISSING (spec A3/A4). */
  normalize(raw: string | null | undefined): string | null;
}

/** Junk placeholders treated as missing. Compared lowercase on the trimmed raw value. */
export const JUNK_VALUES: readonly string[] = ["n/a", "unknown", "none", "-"];

const FIRST_NAME_MIN = 2;
const FIRST_NAME_MAX = 15;

// Letters NFKD does not decompose to ASCII, or decomposes to more than one letter.
const EXTRA_LETTERS: Record<string, string> = {
  "ß": "ss", "æ": "ae", "Æ": "Ae", "œ": "oe", "Œ": "Oe",
  "ø": "o", "Ø": "O", "đ": "d", "Đ": "D", "ð": "d", "Ð": "D",
  "þ": "th", "Þ": "Th", "ł": "l", "Ł": "L", "ı": "i", "ħ": "h", "Ħ": "H",
};

// Typographic variants phone keyboards insert: curly apostrophes → ', Unicode
// hyphens/dashes → -. Without this "O’Neil" cleans to "Oneil".
const PUNCTUATION: Record<string, string> = {
  "’": "'", "‘": "'", "ʼ": "'", "`": "'", "´": "'",
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-",
};

// Latin-1 Supplement + Latin Extended-A/B (U+00C0–U+024F: José, Ștefan) and
// Latin Extended Additional (U+1E00–U+1EFF: Nguyễn).
const TRANSLIT_RANGES: readonly [number, number][] = [[0xc0, 0x24f], [0x1e00, 0x1eff]];

/**
 * Transliteration table: each character's NFKD base letters (José → Jose) over
 * TRANSLIT_RANGES, then EXTRA_LETTERS and PUNCTUATION. GENERATED, not
 * hand-typed, and the SQL twin is generated from this same map — a name must
 * clean to the same length on both sides or the segment-limit count would
 * drift from the send.
 */
export const TRANSLIT: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [from, to] of TRANSLIT_RANGES) {
    for (let cp = from; cp <= to; cp++) {
      const ch = String.fromCodePoint(cp);
      const base = ch.normalize("NFKD").replace(/\p{M}/gu, "");
      if (base !== ch && /^[A-Za-z]+$/.test(base)) m.set(ch, base);
    }
  }
  for (const [k, v] of Object.entries({ ...EXTRA_LETTERS, ...PUNCTUATION })) m.set(k, v);
  return m;
})();

/** USPS code → name: the 50 states + DC. */
export const US_STATES: ReadonlyMap<string, string> = new Map([
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"],
  ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
  ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
  ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"],
  ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"],
  ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"],
  ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
]);

const STATE_BY_NAME: ReadonlyMap<string, string> = new Map(
  [...US_STATES].map(([code, name]) => [name.toLowerCase(), code]),
);

const trimmed = (raw: string | null | undefined): string => (raw ?? "").trim();

function normalizeFirstName(raw: string | null | undefined): string | null {
  const t = trimmed(raw);
  if (!t || JUNK_VALUES.includes(t.toLowerCase()) || /\d/.test(t)) return null;
  const mapped = [...t].map((ch) => TRANSLIT.get(ch) ?? ch).join("");
  // A letter we cannot transliterate is MISSING, never silently deleted:
  // deleting it ships a wrong name ("Ana李" → "Ana"). Non-letters (".", emoji)
  // are dropped below.
  if (/[^\P{L}A-Za-z]/u.test(mapped)) return null;
  const cleaned = mapped
    .replace(/\s+/g, " ")
    .replace(/[^A-Za-z' -]/g, "")
    .replace(/ +/g, " ")
    .trim();
  const letters = cleaned.replace(/[^A-Za-z]/g, "").length;
  if (letters < FIRST_NAME_MIN || cleaned.length > FIRST_NAME_MAX) return null;
  return cleaned.toLowerCase().replace(/(^|[ '-])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

function normalizeZip(raw: string | null | undefined): string | null {
  const m = trimmed(raw).match(/^(\d{5})(?:-?\d{4})?$/);
  return m ? m[1] : null;
}

function normalizeState(raw: string | null | undefined): string | null {
  const t = trimmed(raw);
  if (/^[A-Za-z]{2}$/.test(t)) return US_STATES.has(t.toUpperCase()) ? t.toUpperCase() : null;
  return STATE_BY_NAME.get(t.toLowerCase().replace(/\s+/g, " ")) ?? null;
}

export const TAGS: Record<TagKey, TagDef> = {
  first_name: {
    key: "first_name", label: "First name", scope: "contact",
    maxLength: FIRST_NAME_MAX, worstCase: "X".repeat(FIRST_NAME_MAX), normalize: normalizeFirstName,
  },
  zip: { key: "zip", label: "ZIP code", scope: "contact", maxLength: 5, worstCase: "00000", normalize: normalizeZip },
  state: { key: "state", label: "State", scope: "contact", maxLength: 2, worstCase: "XX", normalize: normalizeState },
  brand: {
    key: "brand", label: "Brand", scope: "campaign", maxLength: 20, worstCase: "X".repeat(20),
    normalize: (raw) => trimmed(raw) || null,
  },
};

export const TAG_KEYS: readonly TagKey[] = Object.keys(TAGS) as TagKey[];

const isTagKey = (s: string): s is TagKey => (TAG_KEYS as readonly string[]).includes(s);

/** Tags used in `text`, distinct, in first-seen order. */
export function findTags(text: string): TagKey[] {
  const out: TagKey[] = [];
  for (const m of text.matchAll(/\{([a-z_]+)\}/g)) {
    if (isTagKey(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** `text` with every tag replaced by its worst-case stand-in (creative editor). */
export function expandWorstCase(text: string): string {
  return text.replace(/\{([a-z_]+)\}/g, (tok, k: string) => (isTagKey(k) ? TAGS[k].worstCase : tok));
}

/** Brace tokens that are neither a tag nor a block — sent literally; the editor warns. */
export function findUnknownTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    const inner = m[0].slice(1, -1);
    const known = isTagKey(inner) || (BLOCK_KEYS as readonly string[]).includes(inner);
    if (!known && !out.includes(m[0])) out.push(m[0]);
  }
  return out;
}
