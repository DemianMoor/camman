import { z } from "zod";

import {
  STANDARD_EVENT_MODEL,
  STATUS_ONLY_KEITARO_TYPES,
} from "@/lib/conversions/standard-model";

// Network-level conversion_event_mappings rules (Keitaro conversion type →
// CamMan event type + status). See docs/04-features/conversion-events.md.
//
// - event_type_id null = a status-only rule ("keeps existing type"): it moves
//   a conversion's status and leaves its locked event type alone. Allowed ONLY
//   for a reversal type (STATUS_ONLY_KEITARO_TYPES) — on any other type a first
//   postback would land unmapped. A first-seen `rejected` still lands unmapped
//   and is alerted (status_only_unmapped); that is accepted for reversals.
// - keitaro_type is immutable after create: changing it is a different rule
//   (deactivate + add), so the update schema doesn't accept it. The PATCH route
//   re-checks a null event_type_id against the stored rule's type.

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

export const STATUS_ONLY_NOT_ALLOWED =
  "Only a rejected or trash rule can keep the existing event type";

export function allowsStatusOnly(keitaroType: string): boolean {
  return STATUS_ONLY_KEITARO_TYPES.includes(keitaroType);
}

// Pre-filled on every new network: the standard event model. Event type is
// named by KEY (resolved to the org's id by the form), since ids are per-org
// serials; null = status-only.
export const DEFAULT_NETWORK_MAPPINGS: readonly {
  keitaro_type: KeitaroConversionType;
  event_type_key: string | null;
  conversion_status: ConversionMappingStatus;
}[] = STANDARD_EVENT_MODEL.map((e) => ({
  keitaro_type: e.keitaroType,
  event_type_key: e.eventTypeKey,
  conversion_status: e.conversionStatus,
}));

const eventTypeId = z
  .number({ message: "Pick an event type" })
  .int()
  .positive()
  .nullable();

const mappingRuleBaseSchema = z.object({
  keitaro_type: z.enum(KEITARO_CONVERSION_TYPES, {
    message: "Pick a Keitaro conversion type",
  }),
  event_type_id: eventTypeId,
  conversion_status: z.enum(CONVERSION_STATUSES, {
    message: "Pick a status",
  }),
});

export const mappingRuleCreateSchema = mappingRuleBaseSchema.refine(
  (d) => d.event_type_id !== null || allowsStatusOnly(d.keitaro_type),
  { message: STATUS_ONLY_NOT_ALLOWED, path: ["event_type_id"] },
);

export const mappingRuleUpdateSchema = mappingRuleBaseSchema
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
