// THE STANDARD CONVERSION EVENT MODEL — one definition for every network.
//
// It drives three things, so they cannot disagree:
//   1. the rules pre-filled on a NEW network (DEFAULT_NETWORK_MAPPINGS,
//      lib/validators/conversion-mappings.ts)
//   2. the per-event Postback URLs a network's advertiser is given
//      (lib/conversions/postback-urls.ts)
//   3. the plain-text advertiser postback spec generated from those URLs
//
// An existing network whose rule differs from this model is an OVERRIDE (e.g.
// Sweeply and Digistore24 send paid sales as `lead`, so their `lead` stays
// Purchase). The mapping dialog labels every such rule; scripts/
// standard-conversion-mapping-diff.ts lists them per network.
// See docs/04-features/conversion-events.md "The standard event model".

export interface StandardEvent {
  /** The Keitaro conversion type (= the `status=` value the advertiser posts). */
  keitaroType: "lead" | "registration" | "sale" | "deposit" | "rejected";
  /** What the advertiser fires it for, in the spec. */
  advertiserLabel: string;
  /** CamMan event type key, or null = keep the conversion's existing type. */
  eventTypeKey: string | null;
  conversionStatus: "approved" | "rejected";
  /** One line: what CamMan counts it as. */
  countsAs: string;
}

export const STANDARD_EVENT_MODEL: readonly StandardEvent[] = [
  {
    keitaroType: "lead",
    advertiserLabel: "Lead",
    eventTypeKey: "lead",
    conversionStatus: "approved",
    countsAs: "a lead: not a sale; its payout counts as revenue when above 0",
  },
  {
    keitaroType: "registration",
    advertiserLabel: "Registration",
    eventTypeKey: "registration",
    conversionStatus: "approved",
    countsAs: "a registration: not a sale, no revenue",
  },
  {
    keitaroType: "sale",
    advertiserLabel: "Sale",
    eventTypeKey: "purchase",
    conversionStatus: "approved",
    countsAs: "a sale, with its payout as revenue",
  },
  {
    keitaroType: "deposit",
    advertiserLabel: "Deposit / upsell",
    eventTypeKey: "upsell",
    conversionStatus: "approved",
    countsAs: "an upsell: revenue only, not an extra sale",
  },
  {
    keitaroType: "rejected",
    advertiserLabel: "Rejection / reversal",
    eventTypeKey: null,
    conversionStatus: "rejected",
    countsAs: "a reversal: the original event's revenue (and sale) is removed",
  },
];

/**
 * The `lead` event type the model needs (created by config, not migration —
 * same as `upsell`). Middle class in the report column order (neither a
 * retarget signal nor a purchase), so it sorts after Reg and before Purchase.
 */
export const LEAD_EVENT_TYPE = {
  key: "lead",
  label: "Lead",
  display_order: 25,
  is_purchase: false,
  counts_revenue: true,
  is_retarget_signal: false,
  // Reports count a lead as a Registration (0232) — reports only; the Registered
  // lane reads is_retarget_signal, which stays false.
  counts_as_registration: true,
} as const;

/**
 * Keitaro types whose rule may be status-only ("keeps existing type"): a
 * reversal changes the status of a conversion that already has a type.
 */
export const STATUS_ONLY_KEITARO_TYPES: readonly string[] = ["rejected", "trash"];

export function standardEventFor(keitaroType: string): StandardEvent | undefined {
  return STANDARD_EVENT_MODEL.find((e) => e.keitaroType === keitaroType);
}

/**
 * True when a rule differs from the standard model. `ruleEventTypeKey` is the
 * rule's event type key, or null for a status-only rule. A Keitaro type the
 * model doesn't cover (e.g. `trash`) is never an override.
 */
export function isOverride(
  keitaroType: string,
  ruleEventTypeKey: string | null,
  ruleStatus: string,
): boolean {
  const std = standardEventFor(keitaroType);
  if (!std) return false;
  return std.eventTypeKey !== ruleEventTypeKey || std.conversionStatus !== ruleStatus;
}
