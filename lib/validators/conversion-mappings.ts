import { z } from "zod";

// Network-level conversion_event_mappings rules (Keitaro conversion type →
// CamMan event type + status). See docs/04-features/conversion-events.md.
//
// - event_type_id is REQUIRED here: the UI never creates status-only rules
//   (NULL event type), which land a first-seen conversion unmapped.
// - keitaro_type is immutable after create: changing it is a different rule
//   (deactivate + add), so the update schema doesn't accept it.

export const KEITARO_CONVERSION_TYPES = [
  "lead",
  "sale",
  "rejected",
  "trash",
  "registration",
  "deposit",
] as const;
export type KeitaroConversionType = (typeof KEITARO_CONVERSION_TYPES)[number];

export const CONVERSION_STATUSES = ["approved", "pending", "rejected"] as const;
export type ConversionMappingStatus = (typeof CONVERSION_STATUSES)[number];

// Pre-filled on every new network. Event type is named by KEY (resolved to the
// org's id by the form), since ids are per-org serials.
export const DEFAULT_NETWORK_MAPPINGS: readonly {
  keitaro_type: KeitaroConversionType;
  event_type_key: string;
  conversion_status: ConversionMappingStatus;
}[] = [
  { keitaro_type: "lead", event_type_key: "purchase", conversion_status: "approved" },
  { keitaro_type: "sale", event_type_key: "purchase", conversion_status: "approved" },
  { keitaro_type: "rejected", event_type_key: "purchase", conversion_status: "rejected" },
];

export const mappingRuleCreateSchema = z.object({
  keitaro_type: z.enum(KEITARO_CONVERSION_TYPES, {
    message: "Pick a Keitaro conversion type",
  }),
  event_type_id: z.number({ message: "Pick an event type" }).int().positive(),
  conversion_status: z.enum(CONVERSION_STATUSES, {
    message: "Pick a status",
  }),
});

export const mappingRuleUpdateSchema = mappingRuleCreateSchema
  .omit({ keitaro_type: true })
  .partial()
  .refine((d) => d.event_type_id !== undefined || d.conversion_status !== undefined, {
    message: "At least one field must be provided",
  });

// The rules sent with POST /api/networks. One rule per Keitaro type — the DB's
// partial unique index would reject a duplicate anyway; this says so up front.
export const mappingRuleListSchema = z
  .array(mappingRuleCreateSchema)
  .max(KEITARO_CONVERSION_TYPES.length)
  .refine((rs) => new Set(rs.map((r) => r.keitaro_type)).size === rs.length, {
    message: "Each Keitaro type can only have one rule",
  });

export type MappingRuleCreateInput = z.infer<typeof mappingRuleCreateSchema>;
export type MappingRuleUpdateInput = z.infer<typeof mappingRuleUpdateSchema>;
