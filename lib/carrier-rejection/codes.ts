// CARRIER REJECTION CODE MAP — the ONE place that decides which delivery-receipt
// failure counts as a carrier rejection, per provider. The ledger SQL
// (lib/carrier-rejection/ledger.ts), the Settings > Sending read-only table and
// the docs all read from here. Owner-specified 2026-10-24 (ClickUp 1amdve2850v).
//
//   hard   — the number is dead or not a mobile line (counted all-time)
//   soft   — the handset was unreachable this time (counted inside the soft window)
//   ignore — everything else, INCLUDING any code not listed here
//
// Providers NOT in this map are excluded entirely. That is deliberate for
// TextHub (txh/txh2): its delivery receipts are fabricated, so none are read.
//
// ⚠️ How each provider reports a failure (measured on prod 2026-10-24):
//   · txr  status 'undelivered'. The POLL row carries 30003/30005/30006/30008 in
//          error_code; the WEBHOOK row leaves error_code NULL and carries
//          1002/2001/2003/3000 only inside raw_body. Same failure, two codes, two
//          rows — the aliases below fold them to one canonical code, and the
//          ledger folds them to ONE outcome per message (stage_send).
//   · ahi  status 'error' (NOT 'undelivered' — the Delivery report misses these,
//          ClickUp 1amdve2850w); the reason text is in `error`.
//   · tls  status 'undelivered'; the reason text is in error_message.
// Ahoi/Tells reasons are matched lower-cased and trimmed.

export type RejectionClass = "hard" | "soft";
export type CarrierRejectionProvider = "txr" | "ahi" | "tls";

export interface ProviderCodeMap {
  label: string;
  hard: readonly string[];
  soft: readonly string[];
  /** Listed for the Settings table only — anything unlisted is ignored too. */
  ignore: readonly string[];
  /** Alternate spelling → canonical code (txr webhook codes). */
  aliases?: Readonly<Record<string, string>>;
}

export const CARRIER_REJECTION_CODES: Record<CarrierRejectionProvider, ProviderCodeMap> = {
  txr: {
    label: "Text Request",
    hard: ["30005", "30006"],
    soft: ["30003"],
    ignore: ["30008", "30004", "30007", "60005"],
    aliases: { "2001": "30005", "2003": "30006", "1002": "30003", "3000": "30008" },
  },
  ahi: {
    label: "Ahoi",
    hard: [
      "Invalid destination address",
      "Teleservice Not Provisioned",
      "Mobile operator not found for the destination address",
    ],
    soft: ["Absent Subscriber", "SM Delivery Failure"],
    ignore: [
      "Invalid client network",
      "Message canceled",
      "This message was identified as spam and cannot be delivered",
      "000",
    ],
  },
  tls: {
    label: "Tells",
    hard: ["Unknown or invalid destination number.", "Landline or unreachable carrier detected."],
    soft: ["Destination handset is unreachable."],
    ignore: ["Message filtered by carrier.", "Network Error"],
  },
};

/** Matching key: trimmed and lower-cased (numeric codes are unaffected). */
export function normalizeRejectionCode(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Canonical code for display/storage: aliases resolved, text kept as listed. */
export function canonicalRejectionCode(provider: CarrierRejectionProvider, raw: string): string {
  const key = normalizeRejectionCode(raw);
  const map = CARRIER_REJECTION_CODES[provider];
  const aliased = map.aliases?.[key];
  if (aliased) return aliased;
  const listed = [...map.hard, ...map.soft, ...map.ignore].find(
    (c) => normalizeRejectionCode(c) === key,
  );
  return listed ?? raw.trim();
}

/** hard | soft | null (= ignore). Unlisted codes are ignored. */
export function classifyRejection(
  provider: CarrierRejectionProvider,
  raw: string | null | undefined,
): RejectionClass | null {
  if (raw == null || raw.trim() === "") return null;
  const map = CARRIER_REJECTION_CODES[provider];
  const key = normalizeRejectionCode(canonicalRejectionCode(provider, raw));
  if (map.hard.some((c) => normalizeRejectionCode(c) === key)) return "hard";
  if (map.soft.some((c) => normalizeRejectionCode(c) === key)) return "soft";
  return null;
}

/**
 * Every normalized spelling that maps to `cls` for a provider, aliases
 * included — what the ledger SQL matches against.
 */
export function matchKeys(provider: CarrierRejectionProvider, cls: RejectionClass): string[] {
  const map = CARRIER_REJECTION_CODES[provider];
  const canon = map[cls].map(normalizeRejectionCode);
  const aliases = Object.entries(map.aliases ?? {})
    .filter(([, to]) => canon.includes(normalizeRejectionCode(to)))
    .map(([from]) => normalizeRejectionCode(from));
  return [...canon, ...aliases];
}
