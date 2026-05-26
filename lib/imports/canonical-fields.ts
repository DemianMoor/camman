// Canonical fields we extract from any provider's CSV row, regardless of
// the column names that provider chose. Mappings (saved templates) link
// these keys to actual CSV header names.

export const CANONICAL_FIELDS = {
  phone_number: {
    required: true,
    description: "The recipient phone number",
  },
  status: {
    required: false,
    description: "Send status (delivered/failed/etc)",
  },
  is_optout: {
    required: false,
    description: "Boolean or status indicating opt-out",
  },
  is_clicker: {
    required: false,
    description: "Boolean or status indicating link click",
  },
  cost: {
    required: false,
    description: "Cost per send for this row",
  },
} as const;

export type CanonicalFieldKey = keyof typeof CANONICAL_FIELDS;

// The shape of a saved mapping's column-name dictionary. Each value is the
// CSV header name that maps to our canonical key; missing keys mean
// "not in this CSV".
export type MappingColumns = Partial<Record<CanonicalFieldKey, string>>;

// Per-provider status word lists, keyed by the canonical outcome they map to.
// e.g. { delivered: ['DELIVERED', 'OK'], failed: ['FAILED'], opt_out: ['STOP'],
//        scrubbed: ['REJECTED_NON_MOBILE'], bounced: ['BOUNCE'] }
//
// scrubbed and bounced both propagate into opt_outs with their respective
// `reason` value, so the contact is excluded from future audience snapshots
// — the same mechanism opt_out uses, but without a brand junction row.
export type StatusValueMap = Partial<
  Record<
    "delivered" | "failed" | "opt_out" | "scrubbed" | "bounced",
    string[]
  >
>;
